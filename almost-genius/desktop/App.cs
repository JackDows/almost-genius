using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.IO;
using System.Net.Http;
using System.Reflection;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

[assembly: AssemblyTitle("Almost Genius")]
[assembly: AssemblyProduct("Almost Genius")]
[assembly: AssemblyVersion("0.4.0.0")]

internal static class Program
{
    internal static readonly string Root = Path.GetFullPath(Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "..", ".."));
    internal static readonly string Data = !String.IsNullOrEmpty(Environment.GetEnvironmentVariable("JIRA_REMINDER_DATA")) ? Path.GetFullPath(Environment.GetEnvironmentVariable("JIRA_REMINDER_DATA")) : File.Exists(Path.Combine(Root, "installed.json")) ? Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "JiraWorkReminder") : Path.Combine(Root, ".local");
    internal const string Home = "http://127.0.0.1:60500/";

    [STAThread]
    private static void Main(string[] args)
    {
        bool created;
        using (var single = new Mutex(true, "Local\\AonorJiraReminderDesktop", out created))
        using (var activation = new EventWaitHandle(false, EventResetMode.AutoReset, "Local\\AonorJiraReminderOpen"))
        {
            if (!created) { if (Array.IndexOf(args, "--background") < 0) activation.Set(); return; }
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            using (var context = new ReminderContext(activation, Array.IndexOf(args, "--background") >= 0))
                Application.Run(context);
            single.ReleaseMutex();
        }
    }
}

internal sealed class ServiceClient : IDisposable
{
    private readonly HttpClient client = new HttpClient(new HttpClientHandler { UseProxy = false, AllowAutoRedirect = false }) { Timeout = TimeSpan.FromSeconds(5) };
    private readonly JavaScriptSerializer json = new JavaScriptSerializer();
    private string token;
    private string instance;

    // 校验本程序的运行实例，端口被别的进程占用时不加载其页面。
    private async Task Authenticate()
    {
        var saved = json.Deserialize<Dictionary<string, object>>(File.ReadAllText(Path.Combine(Program.Data, "runtime.json")));
        var health = json.Deserialize<Dictionary<string, object>>(await client.GetStringAsync(Program.Home + "health"));
        if (Convert.ToString(saved["url"]) != Program.Home || Convert.ToString(health["app"]) != "aonor-jira-reminder-setup" ||
            Convert.ToString(saved["instance"]) != Convert.ToString(health["instance"])) throw new InvalidOperationException();
        var currentInstance = Convert.ToString(health["instance"]);
        if (instance == currentInstance && token != null) return;
        var html = await client.GetStringAsync(Program.Home);
        var match = Regex.Match(html, "name=\"setup-token\" content=\"([a-f0-9]{64})\"");
        if (!match.Success) throw new InvalidOperationException();
        instance = currentInstance;
        token = match.Groups[1].Value;
    }

    internal async Task<Dictionary<string, object>> Request(string endpoint, object body = null)
    {
        await Authenticate();
        using (var request = new HttpRequestMessage(body == null ? HttpMethod.Get : HttpMethod.Post, Program.Home + endpoint))
        {
            request.Headers.Add("x-setup-token", token);
            if (body != null) request.Content = new StringContent(json.Serialize(body), Encoding.UTF8, "application/json");
            using (var response = await client.SendAsync(request))
            {
                if (!response.IsSuccessStatusCode) { token = null; throw new InvalidOperationException(); }
                return json.Deserialize<Dictionary<string, object>>(await response.Content.ReadAsStringAsync());
            }
        }
    }

    internal void StartService()
    {
        var stopped = Path.Combine(Program.Data, "stopped");
        if (File.Exists(stopped)) File.Delete(stopped);
        var shell = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Windows), "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
        Process.Start(new ProcessStartInfo(shell, "-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File \"" + Path.Combine(Program.Root, "Start.ps1") + "\"")
        { UseShellExecute = false, CreateNoWindow = true, WindowStyle = ProcessWindowStyle.Hidden, WorkingDirectory = Program.Root });
    }
    public void Dispose() { client.Dispose(); }
}

internal sealed class ReminderContext : ApplicationContext
{
    private readonly ServiceClient service = new ServiceClient();
    private readonly NotifyIcon tray = new NotifyIcon();
    private readonly System.Windows.Forms.Timer timer = new System.Windows.Forms.Timer { Interval = 5000 };
    private readonly Control dispatcher = new Control();
    private readonly RegisteredWaitHandle wake;
    private readonly ToolStripMenuItem statusItem = new ToolStripMenuItem("正在连接后台…") { Enabled = false };
    private readonly ToolStripMenuItem completeItem = new ToolStripMenuItem("今日已填报");
    private readonly ToolStripMenuItem toggleItem = new ToolStripMenuItem("暂停提醒");
    private readonly Icon green = CreateIcon(Color.FromArgb(39, 112, 86));
    private readonly Icon amber = CreateIcon(Color.FromArgb(183, 130, 47));
    private readonly Icon gray = CreateIcon(Color.FromArgb(127, 134, 139));
    private ReminderWindow window;
    private bool checking, enabled, exiting;
    private DateTime lastStart = DateTime.MinValue;

    internal ReminderContext(EventWaitHandle activation, bool background)
    {
        var unused = dispatcher.Handle;
        wake = ThreadPool.RegisterWaitForSingleObject(activation, (state, timedOut) =>
        { if (!exiting && !dispatcher.IsDisposed) dispatcher.BeginInvoke((Action)Open); }, null, -1, false);
        tray.Icon = gray;
        tray.Text = "Almost Genius · 正在连接";
        tray.Visible = true;
        var menu = new ContextMenuStrip();
        menu.Items.Add(statusItem);
        menu.Items.Add(new ToolStripSeparator());
        menu.Items.Add("打开工作台", null, (sender, e) => Open());
        menu.Items.Add(completeItem);
        menu.Items.Add(toggleItem);
        menu.Items.Add(new ToolStripSeparator());
        menu.Items.Add("退出并暂停提醒", null, async (sender, e) => await ExitAndPause());
        tray.ContextMenuStrip = menu;
        tray.MouseClick += (sender, e) => { if (e.Button == MouseButtons.Left) Open(); };
        completeItem.Click += async (sender, e) => await Command("api/work/complete", new { });
        toggleItem.Click += async (sender, e) => await Command("api/work/enable", new { enabled = !enabled });
        timer.Tick += async (sender, e) => await UpdateStatus();
        timer.Start();
        service.StartService();
        lastStart = DateTime.UtcNow;
        if (!background) Open();
        var task = UpdateStatus();
    }

    private void Open()
    {
        if (exiting) return;
        if (window == null || window.IsDisposed) window = new ReminderWindow(service, green);
        window.Show();
        if (window.WindowState == FormWindowState.Minimized) window.WindowState = FormWindowState.Normal;
        window.Activate();
    }

    private async Task UpdateStatus()
    {
        if (checking || exiting) return;
        checking = true;
        try
        {
            var value = await service.Request("api/status");
            var work = (Dictionary<string, object>)value["work"];
            var today = (Dictionary<string, object>)work["today"];
            enabled = Convert.ToBoolean(work["enabled"]);
            var completed = Convert.ToBoolean(today["completed"]);
            var connection = Convert.ToString(value["connection"]);
            var title = !enabled ? "提醒已暂停" : connection == "connected" ? "正在运行" : "运行中 · 企业微信未连接";
            statusItem.Text = title;
            tray.Text = "Almost Genius · " + title;
            tray.Icon = !enabled ? gray : connection == "connected" ? green : amber;
            completeItem.Enabled = !completed;
            completeItem.Text = completed ? "今日已填报 ✓" : "今日已填报";
            toggleItem.Enabled = true;
            toggleItem.Text = enabled ? "暂停提醒" : "恢复提醒";
            if (window != null && !window.IsDisposed) await window.EnsurePage();
        }
        catch
        {
            if (exiting) return;
            statusItem.Text = "后台未连接 · 正在恢复";
            tray.Text = "Almost Genius · 后台未连接";
            tray.Icon = amber;
            completeItem.Enabled = toggleItem.Enabled = false;
            if (DateTime.UtcNow - lastStart > TimeSpan.FromSeconds(30))
            { lastStart = DateTime.UtcNow; try { service.StartService(); } catch {} }
        }
        finally { checking = false; }
    }

    private async Task Command(string endpoint, object body)
    {
        try { await service.Request(endpoint, body); await UpdateStatus(); }
        catch { tray.ShowBalloonTip(5000, "操作暂未完成", "后台正在恢复，请稍后再试。", ToolTipIcon.Warning); }
    }

    private async Task ExitAndPause()
    {
        if (exiting) return;
        exiting = true;
        try { await service.Request("api/work/enable", new { enabled = false }); await service.Request("api/app/stop", new { }); }
        catch { exiting = false; tray.ShowBalloonTip(5000, "暂时无法暂停", "后台未连接，恢复后可再次退出。", ToolTipIcon.Warning); return; }
        exiting = true;
        if (window != null) { window.AllowClose = true; window.Close(); }
        ExitThread();
    }

    internal static Icon CreateIcon(Color color)
    {
        using (var bitmap = new Bitmap(64, 64))
        using (var g = Graphics.FromImage(bitmap))
        using (var brush = new SolidBrush(color))
        using (var pen = new Pen(Color.White, 6))
        {
            g.SmoothingMode = SmoothingMode.AntiAlias;
            g.Clear(Color.Transparent);
            g.FillEllipse(brush, 2, 2, 60, 60);
            pen.StartCap = pen.EndCap = LineCap.Round;
            g.DrawLines(pen, new[] { new Point(17, 33), new Point(28, 43), new Point(47, 22) });
            var handle = bitmap.GetHicon();
            try { return (Icon)Icon.FromHandle(handle).Clone(); }
            finally { DestroyIcon(handle); }
        }
    }
    [System.Runtime.InteropServices.DllImport("user32.dll")] private static extern bool DestroyIcon(IntPtr handle);

    protected override void Dispose(bool disposing)
    {
        if (disposing)
        {
            exiting = true;
            timer.Stop(); timer.Dispose(); wake.Unregister(null);
            tray.Visible = false; tray.Dispose(); dispatcher.Dispose(); service.Dispose();
            green.Dispose(); amber.Dispose(); gray.Dispose();
        }
        base.Dispose(disposing);
    }
}

internal sealed class ReminderWindow : Form
{
    private readonly ServiceClient service;
    private readonly WebView2 web = new WebView2 { Dock = DockStyle.Fill, DefaultBackgroundColor = Color.FromArgb(247, 248, 245) };
    private readonly Label loading = new Label { Text = "正在打开工作台…", Dock = DockStyle.Fill, TextAlign = ContentAlignment.MiddleCenter, Font = new Font("Microsoft YaHei UI", 13) };
    private bool initializing, loaded;
    internal bool AllowClose;

    internal ReminderWindow(ServiceClient service, Icon icon)
    {
        this.service = service;
        Text = "Almost Genius"; Icon = icon;
        ClientSize = new Size(1120, 780); MinimumSize = new Size(920, 680);
        StartPosition = FormStartPosition.CenterScreen;
        AutoScaleMode = AutoScaleMode.Dpi;
        BackColor = Color.FromArgb(247, 248, 245);
        Controls.Add(web); Controls.Add(loading);
        Shown += async (sender, e) => await EnsurePage();
        FormClosing += (sender, e) => { if (!AllowClose && e.CloseReason == CloseReason.UserClosing) { e.Cancel = true; Hide(); } };
    }

    internal async Task EnsurePage()
    {
        if (loaded || initializing || IsDisposed || !Visible) return;
        initializing = true;
        try
        {
            await service.Request("api/status");
            if (web.CoreWebView2 == null)
            {
                var environment = await CoreWebView2Environment.CreateAsync(null, Path.Combine(Program.Data, "webview"));
                await web.EnsureCoreWebView2Async(environment);
                web.CoreWebView2.Settings.AreDevToolsEnabled = false;
                web.CoreWebView2.Settings.AreDefaultContextMenusEnabled = false;
                web.CoreWebView2.Settings.IsPasswordAutosaveEnabled = false;
                web.CoreWebView2.Settings.IsGeneralAutofillEnabled = false;
                web.CoreWebView2.Settings.IsWebMessageEnabled = false;
                web.CoreWebView2.PermissionRequested += (sender, e) => { e.State = CoreWebView2PermissionState.Deny; };
                web.CoreWebView2.DownloadStarting += (sender, e) =>
                {
                    e.Cancel = true;
                    if (!e.DownloadOperation.Uri.StartsWith("blob:" + Program.Home, StringComparison.Ordinal)) return;
                    using (var dialog = new SaveFileDialog { Filter = "加密备份 (*.jwrbackup)|*.jwrbackup", FileName = "工作提醒-" + DateTime.Now.ToString("yyyyMMdd") + ".jwrbackup", AddExtension = true, DefaultExt = "jwrbackup" })
                    { if (dialog.ShowDialog(this) == DialogResult.OK) { e.ResultFilePath = dialog.FileName; e.Cancel = false; e.Handled = true; } }
                };
                web.CoreWebView2.NewWindowRequested += (sender, e) => { e.Handled = true; OpenJira(e.Uri); };
                web.CoreWebView2.NavigationStarting += (sender, e) =>
                {
                    if (e.Uri.StartsWith("blob:" + Program.Home, StringComparison.Ordinal)) return;
                    Uri uri;
                    if (!Uri.TryCreate(e.Uri, UriKind.Absolute, out uri) || uri.GetLeftPart(UriPartial.Path) != Program.Home)
                    { e.Cancel = true; OpenJira(e.Uri); }
                };
                web.CoreWebView2.NavigationCompleted += (sender, e) =>
                {
                    loaded = e.IsSuccess;
                    loading.Visible = !loaded;
                    if (!loaded) loading.Text = "后台正在恢复，请稍候…";
                };
                web.CoreWebView2.ProcessFailed += (sender, e) => { loaded = false; loading.Visible = true; };
            }
            web.CoreWebView2.Navigate(Program.Home);
        }
        catch { loading.Text = "后台正在启动或恢复，请稍候…"; }
        finally { initializing = false; }
    }

    private static void OpenJira(string value)
    {
        Uri uri;
        if (Uri.TryCreate(value, UriKind.Absolute, out uri) && uri.Scheme == "https" && uri.Host == "jira.aonorx.com" && uri.IsDefaultPort && String.IsNullOrEmpty(uri.UserInfo))
        { try { Process.Start(new ProcessStartInfo(uri.AbsoluteUri) { UseShellExecute = true }); } catch {} }
    }
}
