using System.Runtime.InteropServices;

namespace HikSdk.Interop;

[StructLayout(LayoutKind.Sequential)]
public struct NET_DVR_DEVICEINFO_V30
{
    [MarshalAs(UnmanagedType.ByValArray, SizeConst = 48, ArraySubType = UnmanagedType.U1)]
    public byte[] sSerialNumber;

    public byte byAlarmInPortNum;
    public byte byAlarmOutPortNum;
    public byte byDiskNum;
    public byte byDVRType;
    public byte byChanNum;
    public byte byStartChan;
    public byte byAudioChanNum;
    public byte byIPChanNum;
    public byte byZeroChanNum;
    public byte byMainProto;
    public byte bySubProto;
    public byte bySupport;
    public byte bySupport1;
    public byte bySupport2;
    public ushort wDevType;
    public byte bySupport3;
    public byte byMultiStreamProto;
    public byte byStartDChan;
    public byte byStartDTalkChan;
    public byte byHighDChanNum;
    public byte bySupport4;
    public byte byLanguageType;
    public byte byVoiceInChanNum;
    public byte byStartVoiceInChanNo;
    public byte bySupport5;
    public byte bySupport6;
    public byte byMirrorChanNum;
    public ushort wStartMirrorChanNo;
    public byte bySupport7;
    public byte byRes2;

    public static NET_DVR_DEVICEINFO_V30 Create() =>
        new()
        {
            sSerialNumber = new byte[48]
        };
}

[StructLayout(LayoutKind.Sequential)]
public struct NET_DVR_DEVICEINFO_V40
{
    public NET_DVR_DEVICEINFO_V30 struDeviceV30;
    public byte bySupportLock;
    public byte byRetryLoginTime;
    public byte byPasswordLevel;
    public byte byProxyType;
    public uint dwSurplusLockTime;
    public byte byCharEncodeType;
    public byte bySupportDev5;
    public byte bySupport;
    public byte byLoginMode;
    public uint dwOEMCode;
    public int iResidualValidity;
    public byte byResidualValidity;
    public byte bySingleStartDTalkChan;
    public byte bySingleDTalkChanNums;
    public byte byPassWordResetLevel;
    public byte bySupportStreamEncrypt;
    public byte byMarketType;

    [MarshalAs(UnmanagedType.ByValArray, SizeConst = 238, ArraySubType = UnmanagedType.U1)]
    public byte[] byRes2;

    public static NET_DVR_DEVICEINFO_V40 Create() =>
        new()
        {
            struDeviceV30 = NET_DVR_DEVICEINFO_V30.Create(),
            byRes2 = new byte[238]
        };
}

public delegate void fLoginResultCallBack(
    int lUserID,
    uint dwResult,
    IntPtr lpDeviceInfo,
    IntPtr pUser);

[StructLayout(LayoutKind.Sequential)]
public struct NET_DVR_USER_LOGIN_INFO
{
    [MarshalAs(UnmanagedType.ByValArray, SizeConst = 129, ArraySubType = UnmanagedType.I1)]
    public sbyte[] sDeviceAddress;

    public byte byUseTransport;
    public ushort wPort;

    [MarshalAs(UnmanagedType.ByValArray, SizeConst = 64, ArraySubType = UnmanagedType.I1)]
    public sbyte[] sUserName;

    [MarshalAs(UnmanagedType.ByValArray, SizeConst = 64, ArraySubType = UnmanagedType.I1)]
    public sbyte[] sPassword;

    public fLoginResultCallBack? cbLoginResult;
    public IntPtr pUser;
    public int bUseAsynLogin;
    public byte byProxyType;
    public byte byUseUTCTime;
    public byte byLoginMode;
    public byte byHttps;
    public int iProxyID;
    public byte byVerifyMode;

    [MarshalAs(UnmanagedType.ByValArray, SizeConst = 119, ArraySubType = UnmanagedType.U1)]
    public byte[] byRes3;

    public static NET_DVR_USER_LOGIN_INFO Create() =>
        new()
        {
            sDeviceAddress = new sbyte[129],
            sUserName = new sbyte[64],
            sPassword = new sbyte[64],
            byRes3 = new byte[119]
        };
}
