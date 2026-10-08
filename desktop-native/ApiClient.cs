using System.Net.Http.Json;
using System.Text.Json;
namespace CpeMonitor.Native;

public sealed class ApiClient : IDisposable
{
    private readonly HttpClient client;
    public ApiClient(string? baseUrl = null) : this(new SocketsHttpHandler { UseProxy = false, MaxConnectionsPerServer = 4 }, baseUrl) { }
    internal ApiClient(HttpMessageHandler handler, string? baseUrl = null)
    {
        client = new HttpClient(handler)
        { BaseAddress = new Uri(baseUrl ?? $"http://127.0.0.1:{ServerHost.Port}"), Timeout = TimeSpan.FromSeconds(40) };
    }
    public Task<JsonElement> GetAsync(string path, CancellationToken ct = default) => SendAsync(HttpMethod.Get, path, null, ct);
    public Task<JsonElement> PostAsync(string path, object payload, CancellationToken ct = default) => SendAsync(HttpMethod.Post, path, payload, ct);
    public Task<JsonElement> PutAsync(string path, object payload, CancellationToken ct = default) => SendAsync(HttpMethod.Put, path, payload, ct);
    public Task<JsonElement> DeleteAsync(string path, CancellationToken ct = default) => SendAsync(HttpMethod.Delete, path, null, ct);
    private async Task<JsonElement> SendAsync(HttpMethod method, string path, object? payload, CancellationToken ct)
    {
        using var request = new HttpRequestMessage(method, path);
        if (payload is not null) request.Content = JsonContent.Create(payload);
        using var response = await client.SendAsync(request, ct);
        var text = await response.Content.ReadAsStringAsync(ct);
        JsonElement result;
        try { using var document = JsonDocument.Parse(text); result = document.RootElement.Clone(); }
        catch (JsonException) { throw new InvalidOperationException($"本机服务返回无效数据：HTTP {(int)response.StatusCode}"); }
        if (!response.IsSuccessStatusCode) throw new InvalidOperationException(JsonValues.Text(result, "error", $"请求失败：HTTP {(int)response.StatusCode}"));
        return result;
    }
    public async Task<string> GetTextAsync(string path, CancellationToken ct = default)
    {
        using var response = await client.GetAsync(path, ct);
        response.EnsureSuccessStatusCode();
        return await response.Content.ReadAsStringAsync(ct);
    }
    public void Dispose() => client.Dispose();
}
