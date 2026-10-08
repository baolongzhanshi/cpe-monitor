using System.Text.Json;

namespace CpeMonitor.Native;

internal sealed class SmsView : UserControl, INativeView, INativeActivity
{
    private readonly ApiClient _api;
    private readonly SemaphoreSlim _requests = new(1, 1);
    private CancellationTokenSource _foreground = new();
    private readonly DataGridView _grid = NativeUi.Grid();
    private readonly Label _status = NativeUi.Label("等待短信快照", 9);
    private readonly Label _pagination = NativeUi.Label("第 1 页", 9);
    private readonly Label _detailTitle = NativeUi.Label("短信详情", 10, true);
    private readonly TextBox _detail = NativeUi.TextBox(true);
    private readonly TextBox _keyword = new() { Width = 170, Margin = new Padding(0, 3, 8, 3), PlaceholderText = "号码或短信内容" };
    private readonly ComboBox _filter = new() { DropDownStyle = ComboBoxStyle.DropDownList, Width = 100, Margin = new Padding(0, 3, 8, 3) };
    private readonly ComboBox _direction = new() { DropDownStyle = ComboBoxStyle.DropDownList, Width = 100, Margin = new Padding(0, 3, 8, 3) };
    private readonly Button _sync;
    private readonly Button _search;
    private readonly Button _previous;
    private readonly Button _next;
    private readonly List<Button> _commands = [];
    private int _page = 1;
    private int _total;
    private string _appliedKeyword = "";
    private string _appliedFilter = "all";
    private string _appliedDirection = "all";
    private string _messageSignature = "";

    public int RefreshIntervalSeconds => 15;

    public SmsView(ApiClient api)
    {
        SuspendLayout();
        AutoScaleMode = AutoScaleMode.Dpi;
        AutoScaleDimensions = new SizeF(96, 96);
        _api = api;
        var root = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 1, RowCount = 5, Margin = Padding.Empty };
        root.RowStyles.Add(new RowStyle(SizeType.Absolute, 48)); root.RowStyles.Add(new RowStyle(SizeType.Absolute, 30));
        root.RowStyles.Add(new RowStyle(SizeType.Absolute, 45)); root.RowStyles.Add(new RowStyle(SizeType.Percent, 100)); root.RowStyles.Add(new RowStyle(SizeType.Absolute, 38));
        var header = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 2, RowCount = 1 };
        header.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100)); header.ColumnStyles.Add(new ColumnStyle(SizeType.AutoSize));
        header.Controls.Add(NativeUi.Label("短信", 18, true), 0, 0);
        _sync = NativeUi.Button("立即同步", async (_, _) => await RunCommandAsync(async token =>
        {
            NativeUi.Status(_status, "正在同步短信…");
            await _api.PostAsync("/api/dashboard/sms/sync", new { }, token);
            await RefreshCoreAsync(token);
        }));
        header.Controls.Add(_sync, 1, 0);
        _status.Dock = DockStyle.Fill; _status.AutoSize = false; _status.AutoEllipsis = true;
        _filter.Items.AddRange(["全部状态", "未读", "已读"]); _filter.SelectedIndex = 0;
        _direction.Items.AddRange(["全部方向", "接收", "发送"]); _direction.SelectedIndex = 0;
        var toolbar = new FlowLayoutPanel { Dock = DockStyle.Fill, WrapContents = false };
        toolbar.Controls.Add(_keyword); toolbar.Controls.Add(_filter); toolbar.Controls.Add(_direction);
        _search = NativeUi.Button("搜索", async (_, _) => await ApplyFiltersAsync());
        toolbar.Controls.Add(_search);
        var reset = NativeUi.Button("清除筛选", async (_, _) =>
        {
            _keyword.Clear(); _filter.SelectedIndex = 0; _direction.SelectedIndex = 0;
            await ApplyFiltersAsync();
        });
        toolbar.Controls.Add(reset);
        _keyword.KeyDown += async (_, e) =>
        {
            if (e.KeyCode != Keys.Enter) return;
            e.Handled = true; e.SuppressKeyPress = true; await ApplyFiltersAsync();
        };
        _grid.Columns.Add("date", "时间"); _grid.Columns.Add("phone", "号码"); _grid.Columns.Add("direction", "方向");
        _grid.Columns.Add("content", "内容"); _grid.Columns.Add("read", "状态");
        _grid.Columns[0].FillWeight = 130; _grid.Columns[1].FillWeight = 95; _grid.Columns[2].FillWeight = 45;
        _grid.Columns[3].FillWeight = 240; _grid.Columns[4].FillWeight = 45;
        NativeUi.EmptyText(_grid, "尚未读取本地短信");
        _grid.SelectionChanged += (_, _) => ShowSelectedMessage();
        var split = new SplitContainer
        {
            Size = new Size(800, 360),
            Dock = DockStyle.Fill, Orientation = Orientation.Horizontal, FixedPanel = FixedPanel.Panel2,
            Panel1MinSize = 100, Panel2MinSize = 110, SplitterDistance = 220,
        };
        split.Panel1.Controls.Add(_grid);
        var detailLayout = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 1, RowCount = 2 };
        detailLayout.RowStyles.Add(new RowStyle(SizeType.Absolute, 30)); detailLayout.RowStyles.Add(new RowStyle(SizeType.Percent, 100));
        var detailToolbar = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 2, RowCount = 1 };
        detailToolbar.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100)); detailToolbar.ColumnStyles.Add(new ColumnStyle(SizeType.AutoSize));
        _detailTitle.Dock = DockStyle.Fill; _detailTitle.AutoSize = false; _detailTitle.AutoEllipsis = true;
        detailToolbar.Controls.Add(_detailTitle, 0, 0);
        var copy = NativeUi.Button("复制内容", (_, _) =>
        {
            try { if (!string.IsNullOrEmpty(_detail.Text)) Clipboard.SetText(_detail.Text); }
            catch (Exception error) { NativeUi.Status(_status, error.Message, true); }
        });
        copy.MinimumSize = new Size(84, 26); copy.Padding = new Padding(6, 1, 6, 1);
        detailToolbar.Controls.Add(copy, 1, 0); _detail.ReadOnly = true; _detail.BackColor = Color.White;
        detailLayout.Controls.Add(detailToolbar, 0, 0); detailLayout.Controls.Add(_detail, 0, 1); split.Panel2.Controls.Add(detailLayout);
        var pagination = new FlowLayoutPanel { Dock = DockStyle.Fill, WrapContents = false };
        _previous = NativeUi.Button("上一页", async (_, _) => await RunCommandAsync(async token => { _page--; await RefreshCoreAsync(token); }));
        _next = NativeUi.Button("下一页", async (_, _) => await RunCommandAsync(async token => { _page++; await RefreshCoreAsync(token); }));
        pagination.Controls.Add(_previous); pagination.Controls.Add(_pagination); pagination.Controls.Add(_next);
        _commands.AddRange([_sync, _search, reset, _previous, _next]);
        root.Controls.Add(header, 0, 0); root.Controls.Add(_status, 0, 1); root.Controls.Add(toolbar, 0, 2);
        root.Controls.Add(split, 0, 3); root.Controls.Add(pagination, 0, 4); Controls.Add(root);
        ResumeLayout(true); UpdatePagination();
    }

    private async Task ApplyFiltersAsync() => await RunCommandAsync(async token =>
    {
        _appliedKeyword = _keyword.Text.Trim();
        _appliedFilter = new[] { "all", "unread", "read" }[Math.Max(0, _filter.SelectedIndex)];
        _appliedDirection = new[] { "all", "inbound", "outbound" }[Math.Max(0, _direction.SelectedIndex)];
        _page = 1; await RefreshCoreAsync(token);
    });

    public async Task RefreshAsync(CancellationToken cancellationToken)
    {
        if (!await _requests.WaitAsync(0, cancellationToken)) return;
        using var linked = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken, _foreground.Token);
        try { await RefreshCoreAsync(linked.Token); } finally { _requests.Release(); }
    }

    private async Task RefreshCoreAsync(CancellationToken token)
    {
        var result = await _api.GetAsync($"/api/dashboard/sms?page={_page}&pageSize=50&filter={_appliedFilter}&direction={_appliedDirection}&keyword={Uri.EscapeDataString(_appliedKeyword)}", token);
        token.ThrowIfCancellationRequested();
        if (IsDisposed) return;
        if (NativeUi.Object(result, "messages").ValueKind != JsonValueKind.Array)
            throw new InvalidDataException("短信列表格式不正确");
        _total = Math.Max(0, (int)NativeUi.Number(result, "total"));
        var pageCount = Math.Max(1, (int)Math.Ceiling(_total / 50d));
        if (_page > pageCount) { _page = pageCount; await RefreshCoreAsync(token); return; }
        var messages = NativeUi.Object(result, "messages");
        var signature = messages.ValueKind == JsonValueKind.Array ? messages.GetRawText() : "[]";
        if (signature != _messageSignature)
        {
            var selectedId = (_grid.CurrentRow?.Tag as SmsItem)?.Id;
            var firstRow = _grid.FirstDisplayedScrollingRowIndex;
            _grid.Rows.Clear();
            foreach (var element in NativeUi.Array(result, "messages"))
            {
                var item = new SmsItem(NativeUi.String(element, "id"), NativeUi.String(element, "phone", "—"),
                    NativeUi.String(element, "date"), NativeUi.String(element, "content"), NativeUi.Bool(element, "unread"), NativeUi.String(element, "direction") == "outbound");
                var index = _grid.Rows.Add(NativeUi.Timestamp(item.Date), item.Phone, item.Outbound ? "发送" : "接收",
                    item.Content.Replace('\r', ' ').Replace('\n', ' '), item.Unread ? "未读" : "已读");
                _grid.Rows[index].Tag = item;
                if (item.Id == selectedId) _grid.CurrentCell = _grid.Rows[index].Cells[0];
            }
            if (firstRow >= 0 && firstRow < _grid.Rows.Count) _grid.FirstDisplayedScrollingRowIndex = firstRow;
            _messageSignature = signature; ShowSelectedMessage();
        }
        NativeUi.EmptyText(_grid, string.IsNullOrEmpty(_appliedKeyword) && _appliedFilter == "all" && _appliedDirection == "all"
            ? "本地暂未同步到短信" : "没有符合筛选条件的短信");
        var sync = NativeUi.Object(result, "sync"); var error = NativeUi.String(sync, "lastError");
        var enabled = NativeUi.Bool(sync, "enabled"); var interval = NativeUi.Number(sync, "interval") * 60;
        NativeUi.Status(_status, string.IsNullOrWhiteSpace(error)
            ? $"未读 {NativeUi.Number(result, "unread"):N0} 条 · {(enabled ? $"每 {interval:N0} 秒同步" : "自动同步已关闭")} · 最近同步 {NativeUi.Timestamp(NativeUi.String(sync, "lastSyncedAt"))}"
            : $"最近同步失败：{error}", !string.IsNullOrWhiteSpace(error));
        UpdatePagination();
    }

    private void ShowSelectedMessage()
    {
        if (_grid.CurrentRow?.Tag is not SmsItem item) { _detailTitle.Text = "短信详情"; _detail.Clear(); return; }
        _detailTitle.Text = $"{item.Phone} · {NativeUi.Timestamp(item.Date)} · {(item.Outbound ? "发送" : "接收")}";
        if (_detail.Text != item.Content) _detail.Text = item.Content;
    }

    private void UpdatePagination()
    {
        var pages = Math.Max(1, (int)Math.Ceiling(_total / 50d));
        _pagination.Text = $"第 {_page} / {pages} 页 · 共 {_total} 条";
        _previous.Enabled = _page > 1; _next.Enabled = _page < pages;
    }

    private async Task RunCommandAsync(Func<CancellationToken, Task> command)
    {
        if (!await _requests.WaitAsync(0)) return;
        var originalPage = _page;
        var originalKeyword = _appliedKeyword;
        var originalFilter = _appliedFilter;
        var originalDirection = _appliedDirection;
        var originalTotal = _total;
        foreach (var button in _commands) button.Enabled = false;
        try { await command(_foreground.Token); }
        catch (OperationCanceledException) { RestorePagination(); }
        catch (Exception error) { RestorePagination(); if (!IsDisposed) NativeUi.Status(_status, error.Message, true); }
        finally
        {
            if (!IsDisposed) { foreach (var button in _commands) button.Enabled = true; UpdatePagination(); }
            _requests.Release();
        }
        void RestorePagination()
        {
            _page = originalPage; _appliedKeyword = originalKeyword; _appliedFilter = originalFilter;
            _appliedDirection = originalDirection; _total = originalTotal;
        }
    }

    public void SetForeground(bool active)
    {
        if (!active) _foreground.Cancel();
        else if (_foreground.IsCancellationRequested) { _foreground.Dispose(); _foreground = new CancellationTokenSource(); }
    }

    protected override void Dispose(bool disposing)
    {
        if (disposing && !IsDisposed) { _foreground.Cancel(); _foreground.Dispose(); }
        base.Dispose(disposing);
    }

    private sealed record SmsItem(string Id, string Phone, string Date, string Content, bool Unread, bool Outbound);
}
