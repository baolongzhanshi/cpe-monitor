using System.Drawing.Drawing2D;

namespace CpeMonitor.Native;

internal sealed record ChartSample(DateTimeOffset Time, double? First, double? Second = null);

internal sealed class NativeLineChart : Control
{
    private IReadOnlyList<ChartSample> _samples = [];
    private readonly string _firstName;
    private readonly string? _secondName;
    private readonly string _unit;

    public NativeLineChart(string firstName, string? secondName, string unit)
    {
        _firstName = firstName; _secondName = secondName; _unit = unit;
        Dock = DockStyle.Fill; DoubleBuffered = true; BackColor = Color.White;
        ForeColor = NativeUi.Muted; MinimumSize = new Size(260, 88); ResizeRedraw = true;
        SetStyle(ControlStyles.UserPaint | ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer, true);
    }

    public void SetSamples(IReadOnlyList<ChartSample> samples) { _samples = samples; Invalidate(); }

    protected override void OnPaint(PaintEventArgs e)
    {
        base.OnPaint(e);
        var graphics = e.Graphics;
        graphics.SmoothingMode = SmoothingMode.AntiAlias;
        var plot = new RectangleF(62, 30, Math.Max(1, ClientSize.Width - 84), Math.Max(1, ClientSize.Height - 68));
        var values = _samples.SelectMany(item => new[] { item.First, item.Second })
            .Where(value => value.HasValue && double.IsFinite(value.Value)).Select(value => value!.Value).ToArray();
        if (values.Length == 0)
        {
            TextRenderer.DrawText(graphics, "暂无采集数据", Font, ClientRectangle, NativeUi.Muted,
                TextFormatFlags.HorizontalCenter | TextFormatFlags.VerticalCenter);
            return;
        }
        var minimum = Math.Min(0, values.Min()); var maximum = Math.Max(0, values.Max());
        if (minimum < 0 && maximum == 0) maximum = values.Max();
        if (maximum - minimum < 0.001) maximum = minimum + 1;
        var pad = (maximum - minimum) * 0.1;
        if (minimum < 0) minimum -= pad;
        maximum += pad;
        using var gridPen = new Pen(Color.FromArgb(231, 235, 239));
        for (var i = 0; i <= 4; i++)
        {
            var y = plot.Top + plot.Height * i / 4;
            graphics.DrawLine(gridPen, plot.Left, y, plot.Right, y);
            var value = maximum - (maximum - minimum) * i / 4;
            TextRenderer.DrawText(graphics, value.ToString("0.##"), Font, new Rectangle(0, (int)y - 10, 54, 20),
                NativeUi.Muted, TextFormatFlags.Right | TextFormatFlags.VerticalCenter);
        }
        var firstTime = _samples[0].Time; var lastTime = _samples[^1].Time;
        var span = Math.Max(1, (lastTime - firstTime).TotalSeconds);
        var timeFormat = span > 86400 ? "MM-dd HH:mm" : "HH:mm";
        TextRenderer.DrawText(graphics, firstTime.ToLocalTime().ToString(timeFormat), Font,
            new Rectangle((int)plot.Left, (int)plot.Bottom + 6, 120, 20), NativeUi.Muted, TextFormatFlags.Left);
        TextRenderer.DrawText(graphics, lastTime.ToLocalTime().ToString(timeFormat), Font,
            new Rectangle((int)plot.Right - 120, (int)plot.Bottom + 6, 120, 20), NativeUi.Muted, TextFormatFlags.Right);
        DrawSeries(graphics, plot, firstTime, span, minimum, maximum, sample => sample.First, NativeUi.Accent);
        if (_secondName != null) DrawSeries(graphics, plot, firstTime, span, minimum, maximum, sample => sample.Second, Color.FromArgb(60, 108, 184));
        TextRenderer.DrawText(graphics, $"{_firstName} ({_unit})", Font, new Point((int)plot.Left, 5), NativeUi.Accent);
        if (_secondName != null) TextRenderer.DrawText(graphics, $"{_secondName} ({_unit})", Font, new Point((int)plot.Left + 150, 5), Color.FromArgb(60, 108, 184));
    }

    private void DrawSeries(Graphics graphics, RectangleF plot, DateTimeOffset start, double span,
        double minimum, double maximum, Func<ChartSample, double?> valueOf, Color color)
    {
        using var pen = new Pen(color, 1.8f); using var brush = new SolidBrush(color);
        PointF? previous = null;
        foreach (var sample in _samples)
        {
            var value = valueOf(sample);
            // 缺失的信号数据不补零，也不跨过缺口连线。
            if (!value.HasValue || !double.IsFinite(value.Value)) { previous = null; continue; }
            var point = new PointF(plot.Left + (float)((sample.Time - start).TotalSeconds / span) * plot.Width,
                plot.Bottom - (float)((value.Value - minimum) / (maximum - minimum)) * plot.Height);
            if (previous.HasValue) graphics.DrawLine(pen, previous.Value, point);
            else graphics.FillEllipse(brush, point.X - 2, point.Y - 2, 4, 4);
            previous = point;
        }
    }
}
