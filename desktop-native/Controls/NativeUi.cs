using System.Globalization;
using System.Text.Json;

namespace CpeMonitor.Native;

internal interface INativeView
{
    int RefreshIntervalSeconds { get; }
    Task RefreshAsync(CancellationToken cancellationToken);
}

internal interface INativeActivity
{
    void SetForeground(bool active);
}

internal static class NativeUi
{
    public static readonly Color Background = Color.FromArgb(243, 245, 247);
    public static readonly Color Foreground = Color.FromArgb(23, 33, 43);
    public static readonly Color Muted = Color.FromArgb(100, 114, 129);
    public static readonly Color Accent = Color.FromArgb(0, 107, 116);
    public static readonly Color Error = Color.FromArgb(163, 36, 36);

    public static Label Label(string text, int size = 10, bool bold = false) => new()
    {
        Text = text, AutoSize = true, ForeColor = Foreground,
        Font = new Font("Microsoft YaHei UI", size, bold ? FontStyle.Bold : FontStyle.Regular),
        Margin = new Padding(0, 5, 12, 5), UseMnemonic = false,
    };

    public static Button Button(string text, EventHandler? click = null)
    {
        var button = new Button
        {
            Text = text, AutoSize = true, AutoSizeMode = AutoSizeMode.GrowAndShrink,
            MinimumSize = new Size(88, 32), Padding = new Padding(10, 4, 10, 4),
            Margin = new Padding(0, 0, 8, 0), UseVisualStyleBackColor = true,
        };
        if (click != null) button.Click += click;
        return button;
    }

    public static TextBox TextBox(bool multiline = false) => new()
    {
        Multiline = multiline, ScrollBars = multiline ? ScrollBars.Vertical : ScrollBars.None,
        Dock = DockStyle.Fill, BorderStyle = BorderStyle.FixedSingle,
        Margin = new Padding(0, 4, 0, 4),
    };

    public static DataGridView Grid() => new NativeDataGridView()
    {
        Dock = DockStyle.Fill, ReadOnly = true, AllowUserToAddRows = false,
        AllowUserToDeleteRows = false, AllowUserToResizeRows = false,
        RowHeadersVisible = false, MultiSelect = false,
        SelectionMode = DataGridViewSelectionMode.FullRowSelect,
        BackgroundColor = Color.White, BorderStyle = BorderStyle.FixedSingle,
        AutoSizeColumnsMode = DataGridViewAutoSizeColumnsMode.Fill,
        ColumnHeadersHeightSizeMode = DataGridViewColumnHeadersHeightSizeMode.AutoSize,
        RowTemplate = { Height = 30 },
        DefaultCellStyle = { SelectionBackColor = Color.FromArgb(221, 237, 239), SelectionForeColor = Foreground },
    };

    public static TableLayoutPanel Table(int columns, int rows)
    {
        var table = new TableLayoutPanel
        {
            ColumnCount = columns, RowCount = rows, Dock = DockStyle.Fill,
            AutoSize = false, Margin = Padding.Empty, Padding = Padding.Empty,
        };
        for (var i = 0; i < columns; i++) table.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100f / columns));
        for (var i = 0; i < rows; i++) table.RowStyles.Add(new RowStyle(SizeType.Percent, 100f / rows));
        return table;
    }

    public static GroupBox Card(string title, out FlowLayoutPanel content)
    {
        content = new FlowLayoutPanel
        {
            Dock = DockStyle.Fill, FlowDirection = FlowDirection.TopDown,
            WrapContents = false, AutoScroll = true, Padding = new Padding(12, 8, 12, 8),
        };
        var box = new GroupBox
        {
            Text = title, Dock = DockStyle.Fill, Padding = new Padding(6),
            Margin = new Padding(0, 0, 12, 12), BackColor = Color.White,
        };
        box.Controls.Add(content);
        return box;
    }

    public static void Status(Label label, string text, bool error = false)
    {
        label.Text = text;
        label.ForeColor = error ? Error : Muted;
    }

    public static void EmptyText(DataGridView grid, string text)
    {
        if (grid is NativeDataGridView nativeGrid) nativeGrid.EmptyText = text;
    }

    public static JsonElement Object(JsonElement value, string name) =>
        value.ValueKind == JsonValueKind.Object && value.TryGetProperty(name, out var child) ? child : default;

    public static string String(JsonElement value, string name, string fallback = "")
    {
        var child = Object(value, name);
        return child.ValueKind switch
        {
            JsonValueKind.String => child.GetString() ?? fallback,
            JsonValueKind.Number or JsonValueKind.True or JsonValueKind.False => child.ToString(),
            _ => fallback,
        };
    }

    public static double Number(JsonElement value, string name, double fallback = 0)
    {
        var child = Object(value, name);
        if (child.ValueKind == JsonValueKind.Number && child.TryGetDouble(out var number) && double.IsFinite(number)) return number;
        return double.TryParse(String(value, name), NumberStyles.Float, CultureInfo.InvariantCulture, out var parsed) && double.IsFinite(parsed)
            ? parsed : fallback;
    }

    public static bool Bool(JsonElement value, string name, bool fallback = false)
    {
        var child = Object(value, name);
        if (child.ValueKind == JsonValueKind.True) return true;
        if (child.ValueKind == JsonValueKind.False) return false;
        var text = String(value, name).Trim();
        if (bool.TryParse(text, out var parsed)) return parsed;
        if (text == "1") return true;
        if (text == "0") return false;
        return fallback;
    }

    public static IEnumerable<JsonElement> Array(JsonElement value, string name)
    {
        var child = Object(value, name);
        return child.ValueKind == JsonValueKind.Array ? child.EnumerateArray().ToArray() : [];
    }

    public static string Bytes(double bytes)
    {
        if (!double.IsFinite(bytes) || bytes < 0) return "—";
        var units = new[] { "B", "KB", "MB", "GB", "TB" };
        var index = 0;
        while (Math.Abs(bytes) >= 1024 && index < units.Length - 1) { bytes /= 1024; index++; }
        return $"{bytes:N2} {units[index]}";
    }

    public static string Timestamp(string text)
    {
        if (string.IsNullOrWhiteSpace(text)) return "—";
        // SQLite 的 UTC 字符串没有偏移信息，按 UTC 转成本机时间。
        var normalized = text.Replace(' ', 'T');
        if (normalized.Length == 19) normalized += "Z";
        return DateTimeOffset.TryParse(normalized, CultureInfo.InvariantCulture, DateTimeStyles.AssumeUniversal, out var date)
            ? date.ToLocalTime().ToString("yyyy-MM-dd HH:mm:ss") : text;
    }
}

internal sealed class NativeDataGridView : DataGridView
{
    private string _emptyText = "暂无记录";

    [System.ComponentModel.DesignerSerializationVisibility(System.ComponentModel.DesignerSerializationVisibility.Hidden)]
    public string EmptyText
    {
        get => _emptyText;
        set { if (_emptyText == value) return; _emptyText = value; Invalidate(); }
    }

    protected override void OnPaint(PaintEventArgs e)
    {
        base.OnPaint(e);
        if (Rows.Count != 0 || string.IsNullOrWhiteSpace(_emptyText)) return;
        var top = ColumnHeadersVisible ? ColumnHeadersHeight : 0;
        var bounds = new Rectangle(12, top + 12, Math.Max(0, ClientSize.Width - 24), Math.Max(0, ClientSize.Height - top - 24));
        TextRenderer.DrawText(e.Graphics, _emptyText, Font, bounds, NativeUi.Muted,
            TextFormatFlags.HorizontalCenter | TextFormatFlags.VerticalCenter | TextFormatFlags.WordBreak);
    }
}
