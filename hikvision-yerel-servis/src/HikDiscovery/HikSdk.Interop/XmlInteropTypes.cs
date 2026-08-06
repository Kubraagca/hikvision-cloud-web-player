using System.Runtime.InteropServices;

namespace HikSdk.Interop;

[StructLayout(LayoutKind.Sequential)]
public struct NET_DVR_XML_CONFIG_INPUT
{
    public uint dwSize;
    public IntPtr lpRequestUrl;
    public uint dwRequestUrlLen;
    public IntPtr lpInBuffer;
    public uint dwInBufferSize;
    public uint dwRecvTimeOut;
    public byte byForceEncrpt;
    public byte byNumOfMultiPart;
    public byte byMIMEType;
    public byte byRes1;
    public uint dwSendTimeOut;

    [MarshalAs(UnmanagedType.ByValArray, SizeConst = 24)]
    public byte[] byRes;

    public static NET_DVR_XML_CONFIG_INPUT Create() => new()
    {
        dwSize = (uint)Marshal.SizeOf<NET_DVR_XML_CONFIG_INPUT>(),
        byRes = new byte[24]
    };
}

[StructLayout(LayoutKind.Sequential)]
public struct NET_DVR_XML_CONFIG_OUTPUT
{
    public uint dwSize;
    public IntPtr lpOutBuffer;
    public uint dwOutBufferSize;
    public uint dwReturnedXMLSize;
    public IntPtr lpStatusBuffer;
    public uint dwStatusSize;
    public IntPtr lpDataBuffer;
    public byte byNumOfMultiPart;

    [MarshalAs(UnmanagedType.ByValArray, SizeConst = 23)]
    public byte[] byRes;

    public static NET_DVR_XML_CONFIG_OUTPUT Create() => new()
    {
        dwSize = (uint)Marshal.SizeOf<NET_DVR_XML_CONFIG_OUTPUT>(),
        byRes = new byte[23]
    };
}
