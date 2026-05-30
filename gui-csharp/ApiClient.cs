using System.IO;
using System.Net.Http;
using System.Net.Http.Json;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace AnimeDownloader;

public class ApiClient
{
    private readonly HttpClient _httpClient;
    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        PropertyNameCaseInsensitive = true,
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
    };

    public ApiClient(string baseUrl = "http://localhost:3000")
    {
        _httpClient = new HttpClient
        {
            BaseAddress = new Uri(baseUrl.TrimEnd('/') + "/api/"),
            Timeout = TimeSpan.FromSeconds(30),
        };
    }

    public async Task<HealthResponse?> HealthAsync()
    {
        var response = await _httpClient.GetAsync("health");
        response.EnsureSuccessStatusCode();
        return await response.Content.ReadFromJsonAsync<HealthResponse>(JsonOptions);
    }

    public async Task<SeriesResponse?> FetchEpisodesAsync(string url)
    {
        var encoded = Uri.EscapeDataString(url);
        var response = await _httpClient.GetAsync($"series/episodes?url={encoded}");
        response.EnsureSuccessStatusCode();
        return await response.Content.ReadFromJsonAsync<SeriesResponse>(JsonOptions);
    }

    public async Task<CreateDownloadResponse?> CreateDownloadAsync(CreateDownloadRequest request)
    {
        var response = await _httpClient.PostAsJsonAsync("downloads", request, JsonOptions);
        response.EnsureSuccessStatusCode();
        return await response.Content.ReadFromJsonAsync<CreateDownloadResponse>(JsonOptions);
    }

    public async Task<JobListResponse?> GetJobsAsync()
    {
        var response = await _httpClient.GetAsync("downloads");
        response.EnsureSuccessStatusCode();
        return await response.Content.ReadFromJsonAsync<JobListResponse>(JsonOptions);
    }

    public async Task<JobResponse?> GetJobAsync(string jobId)
    {
        var response = await _httpClient.GetAsync($"downloads/{jobId}");
        response.EnsureSuccessStatusCode();
        return await response.Content.ReadFromJsonAsync<JobResponse>(JsonOptions);
    }

    public async Task<JsonElement?> CancelJobAsync(string jobId)
    {
        var response = await _httpClient.DeleteAsync($"downloads/{jobId}");
        response.EnsureSuccessStatusCode();
        return await response.Content.ReadFromJsonAsync<JsonElement>(JsonOptions);
    }

    public async Task<DeleteFileResponse?> DeleteFileAsync(string jobId, int episodeNumber)
    {
        var response = await _httpClient.DeleteAsync($"downloads/{jobId}/files/{episodeNumber}");
        response.EnsureSuccessStatusCode();
        return await response.Content.ReadFromJsonAsync<DeleteFileResponse>(JsonOptions);
    }

    public async Task<JsonElement?> GetConfigAsync()
    {
        var response = await _httpClient.GetAsync("config");
        response.EnsureSuccessStatusCode();
        return await response.Content.ReadFromJsonAsync<JsonElement>(JsonOptions);
    }

    public async Task<JsonElement?> UpdateConfigAsync(Dictionary<string, object> config)
    {
        var response = await _httpClient.PutAsJsonAsync("config", config, JsonOptions);
        response.EnsureSuccessStatusCode();
        return await response.Content.ReadFromJsonAsync<JsonElement>(JsonOptions);
    }

    /// <summary>
    /// Wait until the server is reachable, retrying every 2 seconds.
    /// Throws OperationCanceledException if cancelled.
    /// </summary>
    public async Task WaitForServerAsync(CancellationToken ct = default)
    {
        while (!ct.IsCancellationRequested)
        {
            try
            {
                var response = await _httpClient.GetAsync("health", ct);
                if (response.IsSuccessStatusCode)
                    return;
            }
            catch
            {
                // server not reachable yet
            }
            await Task.Delay(2000, ct);
        }
    }

    public async Task SubscribeToProgress(
        string jobId,
        Action<SseEvent> onEvent,
        CancellationToken cancellationToken)
    {
        using var response = await _httpClient.GetAsync(
            $"downloads/{jobId}/progress",
            HttpCompletionOption.ResponseHeadersRead,
            cancellationToken);

        response.EnsureSuccessStatusCode();

        using var stream = await response.Content.ReadAsStreamAsync(cancellationToken);
        using var reader = new StreamReader(stream);

        string eventType = "";
        while (!cancellationToken.IsCancellationRequested)
        {
            var line = await reader.ReadLineAsync(cancellationToken);
            if (line == null) break;

            if (line.StartsWith("event: "))
            {
                eventType = line[7..];
            }
            else if (line.StartsWith("data: "))
            {
                var data = line[6..];
                onEvent(new SseEvent { EventType = eventType, Data = data });
                eventType = "";
            }
            // Heartbeat lines start with ':' — ignore
        }
    }
}
