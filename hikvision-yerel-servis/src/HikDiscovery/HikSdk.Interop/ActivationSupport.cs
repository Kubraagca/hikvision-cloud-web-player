using System.Text;

namespace HikSdk.Interop;

public sealed record ActivationResult(bool Success, uint ErrorCode, string ErrorMessage);

public sealed record LoginResult(bool Success, int UserId, uint ErrorCode, string ErrorMessage);
public sealed record StreamEncryptionResult(bool Success, bool Enabled, uint ErrorCode, string ErrorMessage);

public sealed class HikActivationSession : IDisposable
{
    private bool _initialized;
    private int _userId = -1;

    public void Initialize(string logDirectory)
    {
        if (_initialized)
        {
            return;
        }

        SadpInteropValidator.ThrowIfInvalid();
        HikSdkSession.ConfigureSdkInitPaths();

        if (!HikSdkNative.NET_DVR_Init())
        {
            var error = HikSdkSession.CaptureLastError();
            throw new InvalidOperationException($"NET_DVR_Init failed. Error={error.ErrorCode}, Symbol={error.ErrorSymbol}, Message={error.ErrorMessage}");
        }

        Directory.CreateDirectory(logDirectory);
        if (!HikSdkNative.NET_DVR_SetLogToFile(3, logDirectory, true))
        {
            var error = HikSdkSession.CaptureLastError();
            throw new InvalidOperationException($"NET_DVR_SetLogToFile failed. Error={error.ErrorCode}, Symbol={error.ErrorSymbol}, Message={error.ErrorMessage}");
        }

        _initialized = true;
    }

    public ActivationResult ActivateDevice(string ipAddress, ushort sdkPort, string password)
    {
        EnsureInitialized();

        var activateConfig = NET_DVR_ACTIVATECFG.Create();
        Encoding.ASCII.GetBytes(password, 0, password.Length, activateConfig.sPassword, 0);

        var success = HikSdkNative.NET_DVR_ActivateDevice(ipAddress, sdkPort, ref activateConfig);
        if (success)
        {
            return new ActivationResult(true, 0, string.Empty);
        }

        var error = HikSdkSession.CaptureLastError();
        return new ActivationResult(false, error.ErrorCode, $"{error.ErrorSymbol}: {error.ErrorMessage}");
    }

    public LoginResult Login(string ipAddress, ushort sdkPort, string userName, string password)
    {
        EnsureInitialized();
        LogoutIfNeeded();

        var loginInfo = NET_DVR_USER_LOGIN_INFO.Create();
        CopyAscii(ipAddress, loginInfo.sDeviceAddress);
        loginInfo.wPort = sdkPort;
        CopyAscii(userName, loginInfo.sUserName);
        CopyAscii(password, loginInfo.sPassword);
        loginInfo.byLoginMode = 0;
        loginInfo.byHttps = 0;
        loginInfo.bUseAsynLogin = 0;

        var deviceInfo = NET_DVR_DEVICEINFO_V40.Create();
        var userId = HikSdkNative.NET_DVR_Login_V40(ref loginInfo, ref deviceInfo);
        if (userId >= 0)
        {
            _userId = userId;
            return new LoginResult(true, userId, 0, string.Empty);
        }

        var error = HikSdkSession.CaptureLastError();
        return new LoginResult(false, -1, error.ErrorCode, $"{error.ErrorSymbol}: {error.ErrorMessage}");
    }

    public StreamEncryptionResult GetStreamEncryption(uint channel = 1)
    {
        EnsureInitialized();
        EnsureLoggedIn();

        var condition = NET_DVR_STREAMENCRYPTION_COND.Create(channel);
        var config = NET_DVR_STREAMENCRYPTION_CFG.Create();
        uint status = 0;

        var success = HikSdkNative.NET_DVR_GetDeviceConfig(
            _userId,
            HikSdkNative.NET_DVR_GET_STREAMENCRYPTION,
            1,
            ref condition,
            (uint)System.Runtime.InteropServices.Marshal.SizeOf<NET_DVR_STREAMENCRYPTION_COND>(),
            ref status,
            ref config,
            (uint)System.Runtime.InteropServices.Marshal.SizeOf<NET_DVR_STREAMENCRYPTION_CFG>());

        if (success)
        {
            return new StreamEncryptionResult(true, config.byEnable != 0, 0, string.Empty);
        }

        var error = HikSdkSession.CaptureLastError();
        return new StreamEncryptionResult(false, false, error.ErrorCode, $"{error.ErrorSymbol}: {error.ErrorMessage}");
    }

    public StreamEncryptionResult SetStreamEncryption(bool enabled, uint channel = 1)
    {
        EnsureInitialized();
        EnsureLoggedIn();

        var condition = NET_DVR_STREAMENCRYPTION_COND.Create(channel);
        var config = NET_DVR_STREAMENCRYPTION_CFG.Create();
        config.byEnable = enabled ? (byte)1 : (byte)0;
        uint status = 0;

        var success = HikSdkNative.NET_DVR_SetDeviceConfig(
            _userId,
            HikSdkNative.NET_DVR_SET_STREAMENCRYPTION,
            1,
            ref condition,
            (uint)System.Runtime.InteropServices.Marshal.SizeOf<NET_DVR_STREAMENCRYPTION_COND>(),
            ref status,
            ref config,
            (uint)System.Runtime.InteropServices.Marshal.SizeOf<NET_DVR_STREAMENCRYPTION_CFG>());

        if (success)
        {
            return new StreamEncryptionResult(true, enabled, 0, string.Empty);
        }

        var error = HikSdkSession.CaptureLastError();
        return new StreamEncryptionResult(false, enabled, error.ErrorCode, $"{error.ErrorSymbol}: {error.ErrorMessage}");
    }

    public void Dispose()
    {
        LogoutIfNeeded();

        if (_initialized)
        {
            HikSdkNative.NET_DVR_Cleanup();
            _initialized = false;
        }
    }

    private void EnsureInitialized()
    {
        if (!_initialized)
        {
            throw new InvalidOperationException("HCNetSDK oturumu baslatilmadi.");
        }
    }

    private void EnsureLoggedIn()
    {
        if (_userId < 0)
        {
            throw new InvalidOperationException("HCNetSDK login oturumu yok.");
        }
    }

    private void LogoutIfNeeded()
    {
        if (_userId >= 0)
        {
            HikSdkNative.NET_DVR_Logout_V30(_userId);
            _userId = -1;
        }
    }

    private static void CopyAscii(string source, sbyte[] target)
    {
        Array.Clear(target, 0, target.Length);
        var bytes = Encoding.ASCII.GetBytes(source);
        var length = Math.Min(bytes.Length, target.Length - 1);
        for (var i = 0; i < length; i++)
        {
            target[i] = unchecked((sbyte)bytes[i]);
        }
    }
}
