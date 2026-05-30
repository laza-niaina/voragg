using System.ComponentModel;
using System.Runtime.CompilerServices;
using System.Collections.ObjectModel;
using System.Windows;
using System.Windows.Media;

namespace AnimeDownloader;

// --- API DTOs ---

public class EpisodeInfo
{
    public int Number { get; set; }
    public string Title { get; set; } = "";
    public string Url { get; set; } = "";
}

public class ProgressData
{
    public long Bytes { get; set; }
    public long Total { get; set; }
    public double Speed { get; set; }
    public double Percent { get; set; }
}

public class EpisodeData
{
    public int Number { get; set; }
    public string Title { get; set; } = "";
    public string? Url { get; set; }
    public string Status { get; set; } = "";
    public string? Phase { get; set; }
    public ProgressData? Progress { get; set; }
    public string? Error { get; set; }
    public string? Path { get; set; }
}

public class SeriesResponse
{
    public SeriesInfo? Series { get; set; }
    public List<EpisodeInfo>? Episodes { get; set; }
}

public class SeriesInfo
{
    public string Url { get; set; } = "";
}

public class JobResponse
{
    public string JobId { get; set; } = "";
    public string Status { get; set; } = "";
    public List<EpisodeData>? Episodes { get; set; }
    public int EpisodeCount { get; set; }
    public int CompletedCount { get; set; }
    public int ErrorCount { get; set; }
    public string? CreatedAt { get; set; }
    public string? CompletedAt { get; set; }
}

public class JobListResponse
{
    public List<JobResponse>? Jobs { get; set; }
}

public class CreateDownloadRequest
{
    public IReadOnlyList<EpisodeInfo> Episodes { get; set; } = Array.Empty<EpisodeInfo>();
    public string? OutputDir { get; set; }
    public string? Player { get; set; }
    public string? Quality { get; set; }
    public int? MaxConcurrent { get; set; }
}

public class CreateDownloadResponse
{
    public string JobId { get; set; } = "";
    public string Status { get; set; } = "";
    public int EpisodeCount { get; set; }
    public string CreatedAt { get; set; } = "";
}

public class DeleteFileResponse
{
    public string? JobId { get; set; }
    public int? Episode { get; set; }
    public string? Path { get; set; }
    public string? Status { get; set; }
    public string? Error { get; set; }
}

public class HealthResponse
{
    public string Status { get; set; } = "";
    public string Version { get; set; } = "";
}

public class SseEvent
{
    public string EventType { get; init; } = "";
    public string Data { get; init; } = "";
}

// --- Episode Item for Browse Tab ---

public class EpisodeItem : INotifyPropertyChanged
{
    public int Number { get; init; }
    public string Title { get; init; } = "";
    public string Url { get; init; } = "";
    public string DisplayText => $"{Number:D2} - {Title}";

    private bool _isSelected;
    public bool IsSelected
    {
        get => _isSelected;
        set
        {
            if (_isSelected != value)
            {
                _isSelected = value;
                OnPropertyChanged();
            }
        }
    }

    public event PropertyChangedEventHandler? PropertyChanged;
    protected void OnPropertyChanged([CallerMemberName] string name = "")
        => PropertyChanged?.Invoke(this, new PropertyChangedEventArgs(name));
}

// --- View Models for Downloads Tab ---

public class EpisodeViewModel : INotifyPropertyChanged
{
    private static readonly SolidColorBrush BrandBrush = new(Color.FromRgb(0x7C, 0x3A, 0xED));
    private static readonly SolidColorBrush GreenBrush = new(Color.FromRgb(0x10, 0xB9, 0x81));
    private static readonly SolidColorBrush OrangeBrush = new(Color.FromRgb(0xF5, 0x9E, 0x0B));
    private static readonly SolidColorBrush RedBrush = new(Color.FromRgb(0xEF, 0x44, 0x44));
    private static readonly SolidColorBrush GrayBrush = new(Color.FromRgb(0x9C, 0xA3, 0xAF));

    public int Number { get; init; }
    public string Title { get; init; } = "";
    public string JobId { get; set; } = "";
    public string DisplayText => $"{Number:D2} - {Title}";

    private string _status = "pending";
    public string Status
    {
        get => _status;
        set
        {
            if (_status != value)
            {
                _status = value;
                OnPropertyChanged();
                OnPropertyChanged(nameof(StatusBrush));
                OnPropertyChanged(nameof(ShowDelete));
            }
        }
    }

    private string _statusDisplayText = "Pending";
    public string StatusDisplayText
    {
        get => _statusDisplayText;
        set
        {
            if (_statusDisplayText != value)
            {
                _statusDisplayText = value;
                OnPropertyChanged();
            }
        }
    }

    private double _progressPercent;
    public double ProgressPercent
    {
        get => _progressPercent;
        set
        {
            _progressPercent = value;
            OnPropertyChanged();
        }
    }

    private long _downloadedBytes;
    public long DownloadedBytes
    {
        get => _downloadedBytes;
        set { _downloadedBytes = value; OnPropertyChanged(); OnPropertyChanged(nameof(SizeText)); }
    }

    private long _totalBytes;
    public long TotalBytes
    {
        get => _totalBytes;
        set { _totalBytes = value; OnPropertyChanged(); OnPropertyChanged(nameof(SizeText)); }
    }

    public string SizeText => _totalBytes > 0
        ? $"{FormatUtility.FormatSize(_downloadedBytes)} / {FormatUtility.FormatSize(_totalBytes)}"
        : _downloadedBytes > 0
            ? FormatUtility.FormatSize(_downloadedBytes)
            : "";

    private string? _filePath;
    public string? FilePath
    {
        get => _filePath;
        set
        {
            _filePath = value;
            OnPropertyChanged();
            OnPropertyChanged(nameof(ShowDelete));
        }
    }

    public SolidColorBrush StatusBrush => _status switch
    {
        "completed" => GreenBrush,
        "skipped" => OrangeBrush,
        "error" => RedBrush,
        "fetching" or "downloading" => BrandBrush,
        _ => GrayBrush,
    };

    public Visibility ShowDelete => (_status is "completed" or "skipped") && _filePath != null
        ? Visibility.Visible : Visibility.Collapsed;

    public event PropertyChangedEventHandler? PropertyChanged;
    protected void OnPropertyChanged([CallerMemberName] string name = "")
        => PropertyChanged?.Invoke(this, new PropertyChangedEventArgs(name));
}

public class JobViewModel : INotifyPropertyChanged
{
    private static readonly SolidColorBrush TealBrush = new(Color.FromRgb(0x22, 0xD3, 0xEE));
    private static readonly SolidColorBrush GreenBrush = new(Color.FromRgb(0x10, 0xB9, 0x81));
    private static readonly SolidColorBrush OrangeBrush = new(Color.FromRgb(0xF5, 0x9E, 0x0B));
    private static readonly SolidColorBrush RedBrush = new(Color.FromRgb(0xEF, 0x44, 0x44));
    private static readonly SolidColorBrush GrayBrush = new(Color.FromRgb(0x9C, 0xA3, 0xAF));

    public string JobId { get; init; } = "";
    public string JobDisplayId => JobId.Length > 8 ? JobId[..8] : JobId;

    private string _status = "pending";
    private int _completedCount;

    public string Status
    {
        get => _status;
        set
        {
            if (_status != value)
            {
                _status = value;
                OnPropertyChanged();
                OnPropertyChanged(nameof(StatusBrush));
                OnPropertyChanged(nameof(ShowCancel));
                OnPropertyChanged(nameof(ShowDeleteAll));
                OnPropertyChanged(nameof(ShowClear));
            }
        }
    }

    public SolidColorBrush StatusBrush => _status switch
    {
        "running" => TealBrush,
        "completed" => GreenBrush,
        "cancelled" => OrangeBrush,
        "error" => RedBrush,
        _ => GrayBrush,
    };

    public Visibility ShowCancel => _status is "completed" or "cancelled" or "error"
        ? Visibility.Collapsed : Visibility.Visible;

    public Visibility ShowDeleteAll => _status is "completed" or "cancelled" or "error"
        ? Visibility.Visible : Visibility.Collapsed;

    public Visibility ShowClear => _status is "completed" or "cancelled" or "error"
        ? Visibility.Visible : Visibility.Collapsed;

    public int CompletedCount
    {
        get => _completedCount;
        set { _completedCount = value; OnPropertyChanged(); OnPropertyChanged(nameof(ProgressText)); }
    }

    public string ProgressText => $"{CompletedCount}/{Episodes.Count} completed";

    public void UpdateProgress()
    {
        CompletedCount = Episodes.Count(e => e.Status is "completed" or "skipped");
    }

    public ObservableCollection<EpisodeViewModel> Episodes { get; } = new();

    public event PropertyChangedEventHandler? PropertyChanged;
    protected void OnPropertyChanged([CallerMemberName] string name = "")
        => PropertyChanged?.Invoke(this, new PropertyChangedEventArgs(name));
}

// --- Log Entry ---

public enum LogType
{
    Info,
    Success,
    Error,
}

public class LogEntry : INotifyPropertyChanged
{
    private static readonly SolidColorBrush InfoBrush = new(Color.FromRgb(0x9C, 0xA3, 0xAF));
    private static readonly SolidColorBrush SuccessBrush = new(Color.FromRgb(0x10, 0xB9, 0x81));
    private static readonly SolidColorBrush ErrorBrush = new(Color.FromRgb(0xEF, 0x44, 0x44));

    public string Timestamp { get; }
    public string Message { get; }
    public LogType Type { get; }
    public string DisplayText => $"[{Timestamp}] {Message}";
    public SolidColorBrush TextColor => Type switch
    {
        LogType.Success => SuccessBrush,
        LogType.Error => ErrorBrush,
        _ => InfoBrush,
    };

    public LogEntry(string message, LogType type = LogType.Info)
    {
        Timestamp = DateTime.Now.ToString("HH:mm:ss");
        Message = message;
        Type = type;
    }

    public event PropertyChangedEventHandler? PropertyChanged;
    protected void OnPropertyChanged([CallerMemberName] string name = "")
        => PropertyChanged?.Invoke(this, new PropertyChangedEventArgs(name));
}

// --- Utilities ---

public static class FormatUtility
{
    public static string FormatSize(long bytes)
    {
        if (bytes < 1024) return $"{bytes} B";
        if (bytes < 1024 * 1024) return $"{bytes / 1024.0:F1} KB";
        if (bytes < 1024 * 1024 * 1024) return $"{bytes / (1024.0 * 1024):F1} MB";
        return $"{bytes / (1024.0 * 1024 * 1024):F2} GB";
    }

    public static string FormatSpeed(double bytesPerSec)
    {
        if (bytesPerSec < 1024) return $"{bytesPerSec:F0} B/s";
        if (bytesPerSec < 1024 * 1024) return $"{bytesPerSec / 1024:F1} KB/s";
        return $"{bytesPerSec / (1024 * 1024):F1} MB/s";
    }
}
