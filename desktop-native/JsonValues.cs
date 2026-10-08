using System.Globalization;
using System.Text.Json;
namespace CpeMonitor.Native;

public static class JsonValues
{
    public static JsonElement Object(JsonElement value, string name) => value.ValueKind == JsonValueKind.Object && value.TryGetProperty(name, out var child) ? child : default;
    public static string Text(JsonElement value, string name, string fallback = "")
    {
        var child = Object(value, name);
        return child.ValueKind is JsonValueKind.Undefined or JsonValueKind.Null ? fallback : child.ValueKind == JsonValueKind.String ? child.GetString() ?? fallback : child.ToString();
    }
    public static double Number(JsonElement value, string name, double fallback = 0) => double.TryParse(Text(value, name), NumberStyles.Any, CultureInfo.InvariantCulture, out var number) && double.IsFinite(number) ? number : fallback;
    public static bool Bool(JsonElement value, string name, bool fallback = false) => Text(value, name).ToLowerInvariant() switch { "true" or "1" => true, "false" or "0" => false, _ => fallback };
    public static IEnumerable<JsonElement> Items(JsonElement value) => value.ValueKind == JsonValueKind.Array ? value.EnumerateArray().Select(item => item.Clone()) : [];
}
