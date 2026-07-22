using System.Runtime.InteropServices;

namespace HikSdk.Interop;

public static class HikSdkNative
{
    private const string DllName = "HCNetSDK.dll";

    [DllImport(DllName, CallingConvention = CallingConvention.StdCall, CharSet = CharSet.Ansi, ExactSpelling = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool NET_DVR_Init();

    [DllImport(DllName, CallingConvention = CallingConvention.StdCall, CharSet = CharSet.Ansi, ExactSpelling = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool NET_DVR_Cleanup();

    [DllImport(DllName, CallingConvention = CallingConvention.StdCall, CharSet = CharSet.Ansi, ExactSpelling = true)]
    public static extern uint NET_DVR_GetLastError();

    [DllImport(DllName, CallingConvention = CallingConvention.StdCall, CharSet = CharSet.Ansi, ExactSpelling = true)]
    public static extern IntPtr NET_DVR_GetErrorMsg(ref int pErrorNo);

    [DllImport(DllName, CallingConvention = CallingConvention.StdCall, CharSet = CharSet.Ansi, ExactSpelling = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool NET_DVR_SetLogToFile(
        uint nLogLevel,
        [MarshalAs(UnmanagedType.LPStr)] string? strLogDir,
        [MarshalAs(UnmanagedType.Bool)] bool bAutoDel);

    [DllImport(DllName, CallingConvention = CallingConvention.StdCall, CharSet = CharSet.Ansi, ExactSpelling = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool NET_DVR_GetSadpInfoList(int lUserID, ref NET_DVR_SADPINFO_LIST lpSadpInfoList);

    [DllImport(DllName, CallingConvention = CallingConvention.StdCall, CharSet = CharSet.Ansi, ExactSpelling = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool NET_DVR_UpdateSadpInfo(
        int lUserID,
        ref NET_DVR_SADP_VERIFY lpSadpVerify,
        ref NET_DVR_SADPINFO lpSadpInfo);

    [DllImport(DllName, CallingConvention = CallingConvention.StdCall, CharSet = CharSet.Ansi, ExactSpelling = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool NET_DVR_ActivateDevice(
        [MarshalAs(UnmanagedType.LPStr)] string sDVRIP,
        ushort wDVRPort,
        ref NET_DVR_ACTIVATECFG lpActivateCfg);

    [DllImport(DllName, CallingConvention = CallingConvention.StdCall, CharSet = CharSet.Ansi, ExactSpelling = true)]
    public static extern int NET_DVR_Login_V40(
        ref NET_DVR_USER_LOGIN_INFO pLoginInfo,
        ref NET_DVR_DEVICEINFO_V40 lpDeviceInfo);

    [DllImport(DllName, CallingConvention = CallingConvention.StdCall, CharSet = CharSet.Ansi, ExactSpelling = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool NET_DVR_Logout_V30(int lUserID);
}
