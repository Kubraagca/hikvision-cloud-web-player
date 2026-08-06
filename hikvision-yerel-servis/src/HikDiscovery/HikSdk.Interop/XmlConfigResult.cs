namespace HikSdk.Interop;

public sealed record XmlConfigResult(bool Success, string ResponseXml, string StatusXml, uint ErrorCode, string ErrorMessage);
