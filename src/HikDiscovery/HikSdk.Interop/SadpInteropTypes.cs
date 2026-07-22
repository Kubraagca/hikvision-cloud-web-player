using System.Runtime.InteropServices;

namespace HikSdk.Interop;

[StructLayout(LayoutKind.Sequential)]
public struct NET_DVR_IPADDR
{
    [MarshalAs(UnmanagedType.ByValArray, SizeConst = 16, ArraySubType = UnmanagedType.I1)]
    public sbyte[] sIpV4;

    [MarshalAs(UnmanagedType.ByValArray, SizeConst = 128, ArraySubType = UnmanagedType.U1)]
    public byte[] byIPv6;

    public static NET_DVR_IPADDR Create() =>
        new()
        {
            sIpV4 = new sbyte[16],
            byIPv6 = new byte[128]
        };
}

[StructLayout(LayoutKind.Sequential)]
public struct NET_DVR_SADPINFO
{
    public NET_DVR_IPADDR struIP;
    public ushort wPort;
    public ushort wFactoryType;

    [MarshalAs(UnmanagedType.ByValArray, SizeConst = HikConstants.SOFTWARE_VERSION_LEN, ArraySubType = UnmanagedType.I1)]
    public sbyte[] chSoftwareVersion;

    [MarshalAs(UnmanagedType.ByValArray, SizeConst = 16, ArraySubType = UnmanagedType.I1)]
    public sbyte[] chSerialNo;

    public ushort wEncCnt;

    [MarshalAs(UnmanagedType.ByValArray, SizeConst = HikConstants.MACADDR_LEN, ArraySubType = UnmanagedType.U1)]
    public byte[] byMACAddr;

    public NET_DVR_IPADDR struSubDVRIPMask;
    public NET_DVR_IPADDR struGatewayIpAddr;
    public NET_DVR_IPADDR struDnsServer1IpAddr;
    public NET_DVR_IPADDR struDnsServer2IpAddr;
    public byte byDns;
    public byte byDhcp;

    [MarshalAs(UnmanagedType.ByValArray, SizeConst = HikConstants.DEV_ID_LEN, ArraySubType = UnmanagedType.U1)]
    public byte[] szGB28181DevID;

    public byte byActivated;

    [MarshalAs(UnmanagedType.ByValArray, SizeConst = HikConstants.NET_SDK_DEVICE_MODEL_LEN, ArraySubType = UnmanagedType.U1)]
    public byte[] byDeviceModel;

    [MarshalAs(UnmanagedType.ByValArray, SizeConst = 101, ArraySubType = UnmanagedType.U1)]
    public byte[] byRes;

    public static NET_DVR_SADPINFO Create() =>
        new()
        {
            struIP = NET_DVR_IPADDR.Create(),
            chSoftwareVersion = new sbyte[HikConstants.SOFTWARE_VERSION_LEN],
            chSerialNo = new sbyte[16],
            byMACAddr = new byte[HikConstants.MACADDR_LEN],
            struSubDVRIPMask = NET_DVR_IPADDR.Create(),
            struGatewayIpAddr = NET_DVR_IPADDR.Create(),
            struDnsServer1IpAddr = NET_DVR_IPADDR.Create(),
            struDnsServer2IpAddr = NET_DVR_IPADDR.Create(),
            szGB28181DevID = new byte[HikConstants.DEV_ID_LEN],
            byDeviceModel = new byte[HikConstants.NET_SDK_DEVICE_MODEL_LEN],
            byRes = new byte[101]
        };
}

[StructLayout(LayoutKind.Sequential)]
public struct NET_DVR_SADPINFO_LIST
{
    public uint dwSize;
    public ushort wSadpNum;

    [MarshalAs(UnmanagedType.ByValArray, SizeConst = 6, ArraySubType = UnmanagedType.U1)]
    public byte[] byRes;

    [MarshalAs(UnmanagedType.ByValArray, SizeConst = HikConstants.MAX_SADP_NUM, ArraySubType = UnmanagedType.Struct)]
    public NET_DVR_SADPINFO[] struSadpInfo;

    public static NET_DVR_SADPINFO_LIST Create()
    {
        var items = new NET_DVR_SADPINFO[HikConstants.MAX_SADP_NUM];
        for (var i = 0; i < items.Length; i++)
        {
            items[i] = NET_DVR_SADPINFO.Create();
        }

        return new NET_DVR_SADPINFO_LIST
        {
            dwSize = (uint)Marshal.SizeOf<NET_DVR_SADPINFO_LIST>(),
            byRes = new byte[6],
            struSadpInfo = items
        };
    }
}

[StructLayout(LayoutKind.Sequential)]
public struct NET_DVR_SADP_VERIFY
{
    [MarshalAs(UnmanagedType.ByValArray, SizeConst = HikConstants.PASSWD_LEN, ArraySubType = UnmanagedType.I1)]
    public sbyte[] chPassword;

    public NET_DVR_IPADDR struOldIP;
    public ushort wOldPort;

    [MarshalAs(UnmanagedType.ByValArray, SizeConst = 62, ArraySubType = UnmanagedType.U1)]
    public byte[] byRes;

    public static NET_DVR_SADP_VERIFY Create() =>
        new()
        {
            chPassword = new sbyte[HikConstants.PASSWD_LEN],
            struOldIP = NET_DVR_IPADDR.Create(),
            byRes = new byte[62]
        };
}

[StructLayout(LayoutKind.Sequential)]
public struct NET_DVR_ACTIVATECFG
{
    public uint dwSize;

    [MarshalAs(UnmanagedType.ByValArray, SizeConst = HikConstants.PASSWD_LEN, ArraySubType = UnmanagedType.U1)]
    public byte[] sPassword;

    public byte byLoginMode;
    public byte byHttps;

    [MarshalAs(UnmanagedType.ByValArray, SizeConst = 106, ArraySubType = UnmanagedType.U1)]
    public byte[] byRes;

    public static NET_DVR_ACTIVATECFG Create() =>
        new()
        {
            dwSize = (uint)Marshal.SizeOf<NET_DVR_ACTIVATECFG>(),
            sPassword = new byte[HikConstants.PASSWD_LEN],
            byRes = new byte[106]
        };
}
