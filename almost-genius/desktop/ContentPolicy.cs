using System;
using System.IO;

// 桌面对话可打开普通网页；导出仅允许应用提供的三种数据文件。
public static class DesktopContentPolicy
{
    public static bool CanOpenLink(string value)
    {
        Uri uri;
        return Uri.TryCreate(value, UriKind.Absolute, out uri) &&
            (uri.Scheme == "https" || uri.Scheme == "http") &&
            !String.IsNullOrEmpty(uri.Host) && String.IsNullOrEmpty(uri.UserInfo);
    }

    public static string ExportExtension(string filename)
    {
        var extension = Path.GetExtension(filename ?? "").ToLowerInvariant();
        return extension == ".md" || extension == ".json" || extension == ".jwrbackup" ? extension : null;
    }
}
