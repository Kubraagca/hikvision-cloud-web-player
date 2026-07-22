#include <cstring>
#include <filesystem>
#include <iostream>
#include <string>

#include "HCNetSDK.h"

namespace
{
    struct Arguments
    {
        std::string ipAddress;
        std::string password;
        unsigned short port = 8000;
        std::string logDirectory;
    };

    std::string JsonEscape(const std::string& value)
    {
        std::string result;
        result.reserve(value.size() + 8);

        for (const char ch : value)
        {
            switch (ch)
            {
            case '\\':
                result += "\\\\";
                break;
            case '"':
                result += "\\\"";
                break;
            case '\r':
                result += "\\r";
                break;
            case '\n':
                result += "\\n";
                break;
            case '\t':
                result += "\\t";
                break;
            default:
                result += ch;
                break;
            }
        }

        return result;
    }

    void PrintResult(bool success, unsigned long errorCode, const std::string& errorMessage)
    {
        std::cout
            << "{"
            << "\"success\":" << (success ? "true" : "false") << ","
            << "\"errorCode\":" << errorCode << ","
            << "\"errorMessage\":\"" << JsonEscape(errorMessage) << "\""
            << "}"
            << std::endl;
    }

    std::string TryGetErrorMessage()
    {
        long errorNo = 0;
        char* message = NET_DVR_GetErrorMsg(&errorNo);
        if (message == nullptr)
        {
            return std::string();
        }

        return std::string(message);
    }

    bool TryParseUnsignedShort(const std::string& value, unsigned short& port)
    {
        try
        {
            const auto parsed = std::stoul(value);
            if (parsed > 65535)
            {
                return false;
            }

            port = static_cast<unsigned short>(parsed);
            return true;
        }
        catch (...)
        {
            return false;
        }
    }

    bool TryParseArguments(int argc, char* argv[], Arguments& arguments, std::string& error)
    {
        for (int index = 1; index < argc; ++index)
        {
            const std::string current = argv[index];
            if (current == "--ip" && index + 1 < argc)
            {
                arguments.ipAddress = argv[++index];
            }
            else if (current == "--password" && index + 1 < argc)
            {
                arguments.password = argv[++index];
            }
            else if (current == "--port" && index + 1 < argc)
            {
                if (!TryParseUnsignedShort(argv[++index], arguments.port))
                {
                    error = "Gecersiz --port degeri.";
                    return false;
                }
            }
            else if (current == "--logDir" && index + 1 < argc)
            {
                arguments.logDirectory = argv[++index];
            }
            else
            {
                error = "Bilinmeyen veya eksik arguman: " + current;
                return false;
            }
        }

        if (arguments.ipAddress.empty())
        {
            error = "Eksik parametre: --ip";
            return false;
        }

        if (arguments.password.empty())
        {
            const char* passwordFromEnv = std::getenv("HIKSDK_ACTIVATE_PASSWORD");
            if (passwordFromEnv != nullptr)
            {
                arguments.password = passwordFromEnv;
            }
        }

        if (arguments.password.empty())
        {
            error = "Eksik parametre: --password veya HIKSDK_ACTIVATE_PASSWORD";
            return false;
        }

        return true;
    }
}

int main(int argc, char* argv[])
{
    Arguments arguments;
    std::string argumentError;
    if (!TryParseArguments(argc, argv, arguments, argumentError))
    {
        PrintResult(false, 0, argumentError);
        return 1;
    }

    if (!arguments.logDirectory.empty())
    {
        std::error_code directoryError;
        std::filesystem::create_directories(arguments.logDirectory, directoryError);
    }

    if (!NET_DVR_Init())
    {
        const auto errorCode = NET_DVR_GetLastError();
        PrintResult(false, errorCode, TryGetErrorMessage());
        return 1;
    }

    if (!arguments.logDirectory.empty())
    {
        NET_DVR_SetLogToFile(3, const_cast<char*>(arguments.logDirectory.c_str()), TRUE);
    }

    NET_DVR_ACTIVATECFG activateConfig{};
    activateConfig.dwSize = sizeof(NET_DVR_ACTIVATECFG);
    const auto passwordLength = std::min(arguments.password.size(), static_cast<std::size_t>(PASSWD_LEN));
    std::memcpy(activateConfig.sPassword, arguments.password.data(), passwordLength);
    activateConfig.byLoginMode = 0;
    activateConfig.byHttps = 0;

    const BOOL activated = NET_DVR_ActivateDevice(
        const_cast<char*>(arguments.ipAddress.c_str()),
        arguments.port,
        &activateConfig);

    if (!activated)
    {
        const auto errorCode = NET_DVR_GetLastError();
        const auto errorMessage = TryGetErrorMessage();
        NET_DVR_Cleanup();
        PrintResult(false, errorCode, errorMessage);
        return 1;
    }

    NET_DVR_Cleanup();
    PrintResult(true, 0, "");
    return 0;
}
