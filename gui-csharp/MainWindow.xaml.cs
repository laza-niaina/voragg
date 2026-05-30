using System.Collections.ObjectModel;
using System.Net;
using System.Net.Http;
using System.Text.Json;
using System.Windows;
using System.Windows.Controls;
using Microsoft.Win32;

namespace AnimeDownloader;

public partial class MainWindow : Window
{
    private readonly ApiClient _api = new();
    private readonly ObservableCollection<JobViewModel> _downloadJobs = new();
    private readonly ObservableCollection<LogEntry> _logEntries = new();
    private readonly Dictionary<string, CancellationTokenSource> _sseCts = new();
    private List<EpisodeItem> _episodeItems = new();

    public MainWindow()
    {
        InitializeComponent();
        Title = "VoraGG Downloader 1.0.1";
        PlayerCombo.ItemsSource = new[] { "streamtape", "vidmoly" };
        QualityCombo.ItemsSource = new[] { "1080p", "720p", "480p" };
        DownloadJobsControl.ItemsSource = _downloadJobs;
        LogListView.ItemsSource = _logEntries;
        ClearAllButton.Visibility = Visibility.Collapsed;
        Log("Application started", LogType.Info);
    }

    private void Log(string message, LogType type = LogType.Info)
    {
        var entry = new LogEntry(message, type);
        _logEntries.Add(entry);
        // Keep only last 500 entries to avoid memory growth
        while (_logEntries.Count > 500)
            _logEntries.RemoveAt(0);
    }

    // ─── Window lifecycle ────────────────────────────────────────

    private async void Window_Loaded(object sender, RoutedEventArgs e)
    {
        StatusText.Text = "Connecting to server...";
        Log("Connecting to server...", LogType.Info);

        // Reconnect loop — retries until server is up
        await ReconnectAsync();
    }

    // ─── Reconnection logic ─────────────────────────────────────

    private async Task ReconnectAsync()
    {
        try
        {
            await _api.WaitForServerAsync();
            var health = await _api.HealthAsync();
            Dispatcher.Invoke(() =>
            {
                StatusText.Text = $"Server connected — v{health?.Version ?? "?"}";
                Log($"Server connected — v{health?.Version ?? "?"}", LogType.Success);
            });

            // Re-subscribe to any active jobs after reconnect
            await RefreshDownloadsAsync();
            foreach (var job in _downloadJobs)
            {
                if (job.Status is "running" or "pending")
                {
                    StartSseSubscription(job.JobId);
                }
            }
        }
        catch (OperationCanceledException)
        {
            // Shutting down
        }
    }

    // ─── Browse tab: Fetch episodes ──────────────────────────────

    private async void FetchButton_Click(object sender, RoutedEventArgs e)
    {
        var url = UrlTextBox.Text.Trim();
        if (string.IsNullOrEmpty(url) || url == "https://voir-anime.to/...")
        {
            StatusText.Text = "Please enter a valid anime URL";
            return;
        }

        FetchButton.IsEnabled = false;
        StatusText.Text = "Fetching episodes...";
        Log($"Fetching episodes from: {url}");

        try
        {
            var result = await _api.FetchEpisodesAsync(url);
            if (result?.Episodes is null || result.Episodes.Count == 0)
            {
                StatusText.Text = "No episodes found for this URL";
                Log("No episodes found", LogType.Error);
                return;
            }

            _episodeItems = result.Episodes.Select(ep => new EpisodeItem
            {
                Number = ep.Number,
                Title = ep.Title,
                Url = ep.Url,
            }).ToList();

            EpisodeListView.ItemsSource = _episodeItems;
            EpisodeCountText.Text = $"Episodes ({_episodeItems.Count})";
            StatusText.Text = $"Found {_episodeItems.Count} episodes";
            Log($"Found {_episodeItems.Count} episodes", LogType.Success);
            UpdateDownloadButton();
        }
        catch (Exception ex)
        {
            StatusText.Text = $"Fetch failed: {ex.Message}";
            Log($"Fetch failed: {ex.Message}", LogType.Error);
        }
        finally
        {
            FetchButton.IsEnabled = true;
        }
    }

    // ─── Browse tab: episode selection ──────────────────────────

    private void SelectAllButton_Click(object sender, RoutedEventArgs e)
    {
        int from = int.TryParse(FromRangeText.Text, out var f) ? f : 0;
        int to = int.TryParse(ToRangeText.Text, out var t) ? t : int.MaxValue;

        foreach (var item in _episodeItems)
        {
            if (item.Number >= from && item.Number <= to)
                item.IsSelected = true;
        }
        UpdateDownloadButton();
    }

    private void DeselectAllButton_Click(object sender, RoutedEventArgs e)
    {
        foreach (var item in _episodeItems)
            item.IsSelected = false;
        UpdateDownloadButton();
    }

    private void EpisodeCheckChanged(object sender, RoutedEventArgs e)
    {
        UpdateDownloadButton();
    }

    private void UpdateDownloadButton()
    {
        var count = _episodeItems?.Count(e => e.IsSelected) ?? 0;
        DownloadButton.IsEnabled = count > 0;
        DownloadButton.Content = count > 0
            ? $"Download Selected Episodes ({count})"
            : "Download Selected Episodes";
    }

    // ─── Browse tab: output directory picker ────────────────────

    private void BrowseButton_Click(object sender, RoutedEventArgs e)
    {
        var dialog = new OpenFolderDialog
        {
            Title = "Select Output Directory",
        };
        if (dialog.ShowDialog() == true)
            OutputDirTextBox.Text = dialog.FolderName;
    }

    // ─── Browse tab: start download ─────────────────────────────

    private async void DownloadButton_Click(object sender, RoutedEventArgs e)
    {
        var selected = _episodeItems.Where(ep => ep.IsSelected).ToList();
        if (selected.Count == 0) return;

        var episodes = selected.Select(ep => new EpisodeInfo
        {
            Number = ep.Number,
            Title = ep.Title,
            Url = ep.Url,
        }).ToList();

        var outputDir = OutputDirTextBox.Text.Trim();
        var player = PlayerCombo.SelectedItem as string;
        var quality = QualityCombo.SelectedItem as string;
        int? maxConcurrent = int.TryParse(MaxConcurrentText.Text, out var mc) ? mc : null;

        DownloadButton.IsEnabled = false;
        StatusText.Text = "Starting download...";
        Log($"Starting download: {episodes.Count} episodes, player={player}, quality={quality}");

        try
        {
            var response = await _api.CreateDownloadAsync(new CreateDownloadRequest
            {
                Episodes = episodes,
                OutputDir = string.IsNullOrEmpty(outputDir) ? null : outputDir,
                Player = player,
                Quality = quality,
                MaxConcurrent = maxConcurrent,
            });

            if (response is null)
            {
                StatusText.Text = "Failed to create download — empty response";
                Log("Download creation failed — empty response", LogType.Error);
                return;
            }

            var jobVm = new JobViewModel
            {
                JobId = response.JobId,
                Status = "running",
            };

            foreach (var ep in selected)
            {
                jobVm.Episodes.Add(new EpisodeViewModel
                {
                    Number = ep.Number,
                    Title = ep.Title,
                    Status = "pending",
                    JobId = response.JobId,
                });
            }

            _downloadJobs.Add(jobVm);
            NoDownloadsText.Visibility = Visibility.Collapsed;
            UpdateClearAllVisibility();

            StartSseSubscription(response.JobId);
            StatusText.Text = $"Download started — {response.JobId[..8]}";
            Log($"Job {response.JobId[..8]} started with {episodes.Count} episode(s)");
            MainTabControl.SelectedIndex = 1; // switch to Downloads
        }
        catch (Exception ex)
        {
            StatusText.Text = $"Download failed: {ex.Message}";
            Log($"Download failed: {ex.Message}", LogType.Error);
        }
        finally
        {
            DownloadButton.IsEnabled = true;
        }
    }

    // ─── SSE subscription ───────────────────────────────────────

    private void StartSseSubscription(string jobId)
    {
        var cts = new CancellationTokenSource();
        _sseCts[jobId] = cts;

        _ = Task.Run(async () =>
        {
            // Step 1: fetch current job state first to catch any events
            // that already fired before SSE connection was established
            try
            {
                var jobState = await _api.GetJobAsync(jobId);
                if (jobState is not null)
                {
                    Dispatcher.Invoke(() => ApplyJobState(jobId, jobState));
                    if (jobState.Status is "completed" or "cancelled" or "error")
                    {
                        Dispatcher.Invoke(() =>
                            Log($"Job {jobId[..8]} — already {jobState.Status}, no SSE needed", LogType.Info));
                        return;
                    }
                }
            }
            catch (HttpRequestException ex) when (ex.StatusCode == HttpStatusCode.NotFound)
            {
                Dispatcher.Invoke(() =>
                    Log($"Job {jobId[..8]} — not found on server", LogType.Error));
                return;
            }
            catch
            {
                // Server might be down — will retry via SSE loop below
            }

            // Step 2: open SSE stream for real-time updates
            int retryCount = 0;
            const int maxRetries = 10;

            while (!cts.Token.IsCancellationRequested)
            {
                try
                {
                    retryCount = 0;
                    await _api.SubscribeToProgress(jobId, sseEvent =>
                    {
                        Dispatcher.Invoke(() => ProcessSseEvent(jobId, sseEvent));
                    }, cts.Token);

                    // Stream ended naturally — stop retrying
                    break;
                }
                catch (OperationCanceledException)
                {
                    break;
                }
                catch (HttpRequestException ex) when (ex.StatusCode == System.Net.HttpStatusCode.NotFound)
                {
                    Dispatcher.Invoke(() =>
                        Log($"Job {jobId[..8]} — SSE stopped: job not found", LogType.Error));
                    break;
                }
                catch (Exception ex)
                {
                    retryCount++;
                    if (retryCount > maxRetries)
                    {
                        Dispatcher.Invoke(() =>
                            Log($"Job {jobId[..8]} — SSE gave up after {maxRetries} retries", LogType.Error));
                        break;
                    }

                    if (retryCount <= 3)
                    {
                        Dispatcher.Invoke(() =>
                            Log($"Job {jobId[..8]} — SSE lost: {ex.Message}", LogType.Error));
                    }

                    // Check if job is still active before retrying
                    try
                    {
                        var job = await _api.GetJobAsync(jobId);
                        if (job is null || job.Status is "completed" or "cancelled" or "error")
                            break;
                    }
                    catch (HttpRequestException checkEx) when (checkEx.StatusCode == System.Net.HttpStatusCode.NotFound)
                    {
                        break;
                    }
                    catch
                    {
                        // Server down — wait before retry
                    }

                    // Exponential backoff with jitter: 2s, 4s, 8s, 16s, ... capped at 30s
                    int delayMs = Math.Min(2000 * (int)Math.Pow(2, retryCount - 1), 30000);
                    delayMs += Random.Shared.Next(0, 1000);
                    try
                    {
                        await Task.Delay(delayMs, cts.Token);
                    }
                    catch (OperationCanceledException)
                    {
                        break;
                    }
                }
            }

            Dispatcher.Invoke(() => _sseCts.Remove(jobId));
        });
    }

    /// <summary>
    /// Apply fetched job state to the local ViewModel — pre-populates
    /// episodes that have already progressed/completed before SSE opened.
    /// </summary>
    private void ApplyJobState(string jobId, JobResponse jobState)
    {
        var job = _downloadJobs.FirstOrDefault(j => j.JobId == jobId);
        if (job is null) return;

        job.Status = jobState.Status;

        if (jobState.Episodes is null) return;

        foreach (var serverEp in jobState.Episodes)
        {
            var localEp = job.Episodes.FirstOrDefault(e => e.Number == serverEp.Number);
            if (localEp is null) continue;

            // Only update if server has more recent state
            if (serverEp.Status is "completed" or "skipped" or "error")
            {
                localEp.Status = serverEp.Status;
                localEp.StatusDisplayText = serverEp.Status switch
                {
                    "completed" => "Completed",
                    "skipped"   => "Skipped",
                    "error"     => "Error",
                    _           => localEp.StatusDisplayText,
                };
                if (serverEp.Status is "completed" or "skipped")
                    localEp.ProgressPercent = 100;
                localEp.FilePath = serverEp.Path;
            }
            else if (serverEp.Status is "downloading")
            {
                localEp.Status = "downloading";
                localEp.StatusDisplayText = "Downloading...";
                if (serverEp.Progress is not null)
                {
                    localEp.ProgressPercent = serverEp.Progress.Percent;
                    localEp.DownloadedBytes = serverEp.Progress.Bytes;
                    localEp.TotalBytes = serverEp.Progress.Total;
                }
            }
            else if (serverEp.Status is "fetching")
            {
                localEp.Status = "fetching";
                localEp.StatusDisplayText = serverEp.Phase switch
                {
                    "resolving_url"    => "Resolving URL...",
                    "extracting_video" => "Extracting video...",
                    _                  => "Fetching...",
                };
            }
        }
        job.UpdateProgress();
    }

    private void ProcessSseEvent(string jobId, SseEvent sseEvent)
    {
        var job = _downloadJobs.FirstOrDefault(j => j.JobId == jobId);
        if (job is null) return;

        using var doc = JsonDocument.Parse(sseEvent.Data);
        var root = doc.RootElement;

        switch (sseEvent.EventType)
        {
            case "episode-start":
            {
                var epNum = root.GetProperty("episode").GetInt32();
                var ep = job.Episodes.FirstOrDefault(e => e.Number == epNum);
                if (ep is not null)
                {
                    ep.Status = "fetching";
                    ep.StatusDisplayText = "Starting...";
                    ep.ProgressPercent = 0;
                    Log($"Job {jobId[..8]} — Episode {epNum} started");
                }
                break;
            }

            case "progress":
            {
                var epNum = root.GetProperty("episode").GetInt32();
                var ep = job.Episodes.FirstOrDefault(e => e.Number == epNum);
                if (ep is not null)
                {
                    // Check if server sent a phase field
                    if (root.TryGetProperty("phase", out var phaseEl))
                    {
                        var phase = phaseEl.GetString();
                        ep.Status = phase switch
                        {
                            "resolving_url" or "extracting_video" => "fetching",
                            "downloading" => "downloading",
                            _ => ep.Status,
                        };
                        ep.StatusDisplayText = phase switch
                        {
                            "resolving_url" => "Resolving URL...",
                            "extracting_video" => "Extracting video...",
                            "downloading" => "Downloading...",
                            "completed" => "Completed",
                            "skipped" => "Skipped",
                            "error" => "Error",
                            _ => ep.StatusDisplayText,
                        };
                    }

                    ep.ProgressPercent = root.GetProperty("percent").GetDouble();
                    var speed = root.GetProperty("speed").GetDouble();
                    ep.DownloadedBytes = root.GetProperty("bytes").GetInt64();
                    ep.TotalBytes = root.GetProperty("total").GetInt64();

                    // Show download state: percent + size + speed (if available)
                    if (ep.Status == "downloading")
                    {
                        var pct = (int)Math.Round(ep.ProgressPercent);
                        var size = ep.SizeText;
                        if (speed > 0)
                            ep.StatusDisplayText = $"Download {pct}% — {FormatUtility.FormatSpeed(speed)}";
                        else if (!string.IsNullOrEmpty(size))
                            ep.StatusDisplayText = $"Download {pct}% — {size}";
                        else
                            ep.StatusDisplayText = $"Download {pct}%";
                    }
                }
                break;
            }

            case "episode-complete":
            {
                var epNum = root.GetProperty("episode").GetInt32();
                var ep = job.Episodes.FirstOrDefault(e => e.Number == epNum);
                if (ep is not null)
                {
                    var skipped = root.TryGetProperty("skipped", out var skipEl) && skipEl.GetBoolean();
                    ep.Status = skipped ? "skipped" : "completed";
                    ep.ProgressPercent = 100;
                    ep.StatusDisplayText = skipped ? "Skipped" : "Completed";
                    if (root.TryGetProperty("path", out var pathEl))
                        ep.FilePath = pathEl.GetString();
                    Log($"Job {jobId[..8]} — Episode {epNum} {(skipped ? "skipped" : "completed")}",
                        skipped ? LogType.Info : LogType.Success);
                }
                job.UpdateProgress();
                break;
            }

            case "episode-error":
            {
                var epNum = root.GetProperty("episode").GetInt32();
                var ep = job.Episodes.FirstOrDefault(e => e.Number == epNum);
                var errorMsg = root.TryGetProperty("error", out var errEl) ? errEl.GetString() : "Unknown error";
                if (ep is not null)
                {
                    ep.Status = "error";
                    ep.StatusDisplayText = "Error";
                    Log($"Job {jobId[..8]} — Episode {epNum} error: {errorMsg}", LogType.Error);
                }
                break;
            }

            case "episode-skip":
            {
                var epNum = root.GetProperty("episode").GetInt32();
                var ep = job.Episodes.FirstOrDefault(e => e.Number == epNum);
                if (ep is not null)
                {
                    ep.Status = "skipped";
                    ep.ProgressPercent = 100;
                    ep.StatusDisplayText = "Skipped";
                }
                job.UpdateProgress();
                break;
            }

            case "cancelled":
            {
                job.Status = "cancelled";
                // Mark any in-progress episodes as cancelled
                foreach (var ep in job.Episodes)
                {
                    if (ep.Status is "pending" or "fetching" or "downloading")
                    {
                        ep.Status = "cancelled";
                        ep.StatusDisplayText = "Cancelled";
                    }
                }
                job.UpdateProgress();
                if (_sseCts.TryGetValue(jobId, out var cts))
                {
                    cts.Cancel();
                }
                UpdateClearAllVisibility();
                StatusText.Text = $"Job {jobId[..8]} cancelled";
                Log($"Job {jobId[..8]} cancelled", LogType.Info);
                break;
            }

            case "complete":
            {
                job.Status = "completed";
                job.UpdateProgress();
                if (_sseCts.TryGetValue(jobId, out var cts))
                {
                    cts.Cancel();
                }
                UpdateClearAllVisibility();
                StatusText.Text = $"Job {jobId[..8]} completed";
                Log($"Job {jobId[..8]} completed", LogType.Success);
                break;
            }
        }
    }

    // ─── Downloads tab: cancel / delete ─────────────────────────

    private async void CancelJob_Click(object sender, RoutedEventArgs e)
    {
        if (sender is not Button btn || btn.DataContext is not JobViewModel job)
            return;

        try
        {
            await _api.CancelJobAsync(job.JobId);
            job.Status = "cancelled";
            if (_sseCts.TryGetValue(job.JobId, out var cts))
            {
                cts.Cancel();
            }
            StatusText.Text = $"Job {job.JobId[..8]} cancelled";
            Log($"Job {job.JobId[..8]} cancelled");
        }
        catch (Exception ex)
        {
            StatusText.Text = $"Cancel failed: {ex.Message}";
            Log($"Cancel job {job.JobId[..8]} failed: {ex.Message}", LogType.Error);
        }
    }

    private async void DeleteEpisode_Click(object sender, RoutedEventArgs e)
    {
        if (sender is not Button btn || btn.DataContext is not EpisodeViewModel ep)
            return;

        try
        {
            var result = await _api.DeleteFileAsync(ep.JobId, ep.Number);
            if (result?.Error is not null)
            {
                StatusText.Text = $"Delete failed: {result.Error}";
                Log($"Delete episode {ep.Number} failed: {result.Error}", LogType.Error);
                return;
            }
            ep.Status = "pending";
            ep.FilePath = null;
            ep.StatusDisplayText = "";
            ep.ProgressPercent = 0;
            StatusText.Text = $"Episode {ep.Number} file deleted";
            Log($"Episode {ep.Number} file deleted");
        }
        catch (Exception ex)
        {
            StatusText.Text = $"Delete failed: {ex.Message}";
            Log($"Delete episode {ep.Number} failed: {ex.Message}", LogType.Error);
        }
    }

    private async void DeleteAllFiles_Click(object sender, RoutedEventArgs e)
    {
        if (sender is not Button btn || btn.DataContext is not JobViewModel job)
            return;

        var deletable = job.Episodes
            .Where(ep => ep.Status is "completed" or "skipped" && ep.FilePath is not null)
            .ToList();

        if (deletable.Count == 0) return;

        btn.IsEnabled = false;
        int success = 0;

        foreach (var ep in deletable)
        {
            try
            {
                var result = await _api.DeleteFileAsync(job.JobId, ep.Number);
                if (result?.Error is null)
                {
                    ep.Status = "pending";
                    ep.FilePath = null;
                    ep.StatusDisplayText = "";
                    ep.ProgressPercent = 0;
                    success++;
                }
            }
            catch
            {
                // continue deleting other files
            }
        }

        btn.IsEnabled = true;
        StatusText.Text = $"Deleted {success}/{deletable.Count} files";
        Log($"Job {job.JobId[..8]}: deleted {success}/{deletable.Count} file(s)");
    }

    // ─── Downloads tab: clear / clear all ───────────────────────

    private void ClearJob_Click(object sender, RoutedEventArgs e)
    {
        if (sender is not Button btn || btn.DataContext is not JobViewModel job)
            return;

        if (_sseCts.TryGetValue(job.JobId, out var cts))
        {
            cts.Cancel();
            _sseCts.Remove(job.JobId);
        }

        _downloadJobs.Remove(job);
        UpdateClearAllVisibility();
        Log($"Job {job.JobId[..8]} cleared from list");
    }

    private void ClearAllCompleted_Click(object sender, RoutedEventArgs e)
    {
        var terminal = _downloadJobs
            .Where(j => j.Status is "completed" or "cancelled" or "error")
            .ToList();

        foreach (var job in terminal)
        {
            if (_sseCts.TryGetValue(job.JobId, out var cts))
            {
                cts.Cancel();
                _sseCts.Remove(job.JobId);
            }
            _downloadJobs.Remove(job);
        }

        UpdateClearAllVisibility();
        StatusText.Text = $"Cleared {terminal.Count} job(s)";
        Log($"Cleared {terminal.Count} completed/cancelled job(s) from list");
    }

    private void UpdateClearAllVisibility()
    {
        NoDownloadsText.Visibility = _downloadJobs.Count == 0
            ? Visibility.Visible : Visibility.Collapsed;

        ClearAllButton.Visibility = _downloadJobs.Any(j => j.Status is "completed" or "cancelled" or "error")
            ? Visibility.Visible : Visibility.Collapsed;
    }

    private void ClearLog_Click(object sender, RoutedEventArgs e)
    {
        _logEntries.Clear();
        Log("Log cleared");
    }

    // ─── Tab switching ──────────────────────────────────────────

    private async void TabControl_SelectionChanged(object sender, SelectionChangedEventArgs e)
    {
        if (MainTabControl.SelectedIndex == 1 && _downloadJobs.Count == 0)
        {
            await RefreshDownloadsAsync();
        }
        else if (MainTabControl.SelectedIndex == 2)
        {
            await LoadConfigAsync();
        }
    }

    private async Task RefreshDownloadsAsync()
    {
        // Retry a few times if server is temporarily unavailable
        for (int attempt = 0; attempt < 3; attempt++)
        {
            try
            {
                var result = await _api.GetJobsAsync();
                if (result?.Jobs is null) return;

                int loaded = 0;
                foreach (var job in result.Jobs)
                {
                    if (_downloadJobs.Any(j => j.JobId == job.JobId)) continue;
                    loaded++;

                    var jobVm = new JobViewModel
                    {
                        JobId = job.JobId,
                        Status = job.Status,
                    };

                    if (job.Episodes is not null)
                    {
                        foreach (var ep in job.Episodes)
                        {
                            var epVm = new EpisodeViewModel
                            {
                                Number = ep.Number,
                                Title = ep.Title,
                                Status = ep.Status,
                                ProgressPercent = ep.Progress?.Percent ?? 0,
                                FilePath = ep.Path,
                                JobId = job.JobId,
                            };

                            if (ep.Status == "fetching" && !string.IsNullOrEmpty(ep.Phase))
                            {
                                epVm.StatusDisplayText = ep.Phase switch
                                {
                                    "resolving_url" => "Resolving URL...",
                                    "extracting_video" => "Extracting video...",
                                    _ => "",
                                };
                            }
                            else
                            {
                                epVm.StatusDisplayText = ep.Status switch
                                {
                                    "completed" => "Completed",
                                    "skipped" => "Skipped",
                                    "error" => "Error",
                                    _ => "",
                                };
                            }

                            if (ep.Progress is not null)
                            {
                                epVm.DownloadedBytes = ep.Progress.Bytes;
                                epVm.TotalBytes = ep.Progress.Total;
                            }

                            jobVm.Episodes.Add(epVm);
                        }
                    }

                    _downloadJobs.Add(jobVm);

                    // Re-subscribe SSE for active jobs
                    if (job.Status is "running" or "pending")
                    {
                        StartSseSubscription(job.JobId);
                    }
                }

                if (loaded > 0)
                    Log($"Loaded {loaded} job(s) from server");

                if (_downloadJobs.Count > 0)
                    NoDownloadsText.Visibility = Visibility.Collapsed;

                UpdateClearAllVisibility();
                return; // success — exit
            }
            catch (Exception ex)
            {
                if (attempt < 2)
                {
                    await Task.Delay(1000);
                    continue;
                }
                StatusText.Text = $"Failed to load downloads: {ex.Message}";
                Log($"Failed to load downloads: {ex.Message}", LogType.Error);
            }
        }
    }

    // ─── Settings tab ───────────────────────────────────────────

    private async Task LoadConfigAsync()
    {
        try
        {
            var config = await _api.GetConfigAsync();
            if (config is not null)
            {
                ConfigTextBox.Text = JsonSerializer.Serialize(config, new JsonSerializerOptions
                {
                    WriteIndented = true,
                });
            }
        }
        catch
        {
            // silently ignore — settings tab is a convenience
        }
    }

    private async void SaveConfig_Click(object sender, RoutedEventArgs e)
    {
        try
        {
            var dict = JsonSerializer.Deserialize<Dictionary<string, JsonElement>>(ConfigTextBox.Text);
            if (dict is null)
            {
                StatusText.Text = "Invalid configuration JSON";
                Log("Invalid configuration JSON", LogType.Error);
                return;
            }

            // Convert to Dictionary<string, object> for the API
            var config = new Dictionary<string, object>();
            foreach (var (key, value) in dict)
            {
                config[key] = value.ValueKind switch
                {
                    JsonValueKind.String => value.GetString()!,
                    JsonValueKind.Number => value.TryGetInt64(out var l) ? (object)l : value.GetDouble(),
                    JsonValueKind.True => true,
                    JsonValueKind.False => false,
                    _ => value.ToString(),
                };
            }

            await _api.UpdateConfigAsync(config);
            StatusText.Text = "Configuration saved";
            Log("Configuration saved");
        }
        catch (JsonException)
        {
            StatusText.Text = "Invalid JSON format";
            Log("Invalid JSON format in config", LogType.Error);
        }
        catch (Exception ex)
        {
            StatusText.Text = $"Save failed: {ex.Message}";
            Log($"Save configuration failed: {ex.Message}", LogType.Error);
        }
    }
}
