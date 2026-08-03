using System.Runtime.InteropServices;

namespace HikSdk.Interop;

[StructLayout(LayoutKind.Sequential)]
public struct NET_DVR_STREAMENCRYPTION_COND
{
    public uint dwSize;
    public uint dwChan;

    [MarshalAs(UnmanagedType.ByValArray, SizeConst = 128, ArraySubType = UnmanagedType.U1)]
    public byte[] byRes;

    public static NET_DVR_STREAMENCRYPTION_COND Create(uint channel) =>
        new()
        {
            dwSize = (uint)Marshal.SizeOf<NET_DVR_STREAMENCRYPTION_COND>(),
            dwChan = channel,
            byRes = new byte[128]
        };
}

[StructLayout(LayoutKind.Sequential)]
public struct NET_DVR_STREAMENCRYPTION_CFG
{
    public uint dwSize;
    public byte byEnable;

    [MarshalAs(UnmanagedType.ByValArray, SizeConst = 255, ArraySubType = UnmanagedType.U1)]
    public byte[] byRes;

    public static NET_DVR_STREAMENCRYPTION_CFG Create() =>
        new()
        {
            dwSize = (uint)Marshal.SizeOf<NET_DVR_STREAMENCRYPTION_CFG>(),
            byRes = new byte[255]
        };
}
