# Hikvision Device Network SDK Inceleme Raporu

Bu rapor yalnızca su dosyalardan cikarilan gercek adlara dayanir:

- `C:\Users\Kubra\Downloads\EN-HCNetSDKV6.1.9.4_build20220412_win64.rar`
- [HCNetSDK.h](/abs/path/C:/Users/Kubra/Desktop/kamera/_analysis/sdk/EN-HCNetSDKV6.1.9.4_build20220412_win64/incEn/HCNetSDK.h:50290)
- [DataType.h](/abs/path/C:/Users/Kubra/Desktop/kamera/_analysis/sdk/EN-HCNetSDKV6.1.9.4_build20220412_win64/incEn/DataType.h)
- [HCNetSDK.cs](/abs/path/C:/Users/Kubra/Desktop/kamera/_analysis/sdk/appsdemo/AppsDemo_build20201230191326/CommonBase/Head/HCNetSDK.cs:6003)
- `Device Network SDK Programming Manual.chm`
- `Device Network SDK (General)_Developer Guide_V6.1.7.X_20220310.ZIP`
- `Hik-Connect for Teams OpenAPI Developer Guide_V2.15.0_20260306.pdf` dosyasi bu raporda ayrintili analiz edilmedi; Stage 4 icin ayri backend notu olarak ele alinmistir.

## Paket ozeti

RAR icinde dogrulanan ana bilesenler:

- Header: `incEn/HCNetSDK.h`, `incEn/DataType.h`
- Ana DLL/LIB: `lib/HCNetSDK.dll`, `lib/HCNetSDK.lib`
- Yardimci DLL klasoru: `lib/HCNetSDKCom/*`
- Diger runtime dosyalari: `HCCore.dll`, `hpr.dll`, `hlog.dll`, `PlayCtrl.dll`, `OpenAL32.dll`, `libcrypto-1_1-x64.dll`, `libssl-1_1-x64.dll` vb.
- C# ornekleri: `C# demo/7-Remote configuration.zip`, `C# demo/9-AppsDemo_build20201230191326.zip`
- C++ ornekleri: `ClientDemo/*`
- Dokuman: `Device Network SDK Programming Manual.chm`, `Device Network SDK (General)_Developer Guide_V6.1.7.X_20220310.ZIP`

Not: Calisma klasorundeki mevcut `sdk/dist/*` agaci Device Network SDK degil, web oynatma/plugin dosyalari iceriyor. Bu nedenle cihaz kesfi/aktivasyon icin referans alinmamali.

## Istekteki 1-8 eslestirmesi

### 1. SDK baslatma ve kapatma

Dogru fonksiyonlar:

- `NET_DVR_Init()` [HCNetSDK.h](/abs/path/C:/Users/Kubra/Desktop/kamera/_analysis/sdk/EN-HCNetSDKV6.1.9.4_build20220412_win64/incEn/HCNetSDK.h:50290)
- `NET_DVR_Cleanup()` [HCNetSDK.h](/abs/path/C:/Users/Kubra/Desktop/kamera/_analysis/sdk/EN-HCNetSDKV6.1.9.4_build20220412_win64/incEn/HCNetSDK.h:50291)
- `NET_DVR_SetLogToFile(...)` [HCNetSDK.h](/abs/path/C:/Users/Kubra/Desktop/kamera/_analysis/sdk/EN-HCNetSDKV6.1.9.4_build20220412_win64/incEn/HCNetSDK.h:50729)
- `NET_DVR_SetSDKInitCfg(...)` [HCNetSDK.h](/abs/path/C:/Users/Kubra/Desktop/kamera/_analysis/sdk/EN-HCNetSDKV6.1.9.4_build20220412_win64/incEn/HCNetSDK.h:51301)

C# declare edilmis olanlar:

- `NET_DVR_Init()` [HCNetSDK.cs](/abs/path/C:/Users/Kubra/Desktop/kamera/_analysis/sdk/appsdemo/AppsDemo_build20201230191326/CommonBase/Head/HCNetSDK.cs:6003)
- `NET_DVR_Cleanup()` [HCNetSDK.cs](/abs/path/C:/Users/Kubra/Desktop/kamera/_analysis/sdk/appsdemo/AppsDemo_build20201230191326/CommonBase/Head/HCNetSDK.cs:6013)

### 2. Ayni yerel agdaki kameralari Layer-2/MAC tabanli bulma

Header icinde ilgili veri yapilari var:

- `NET_DVR_SADPINFO` [HCNetSDK.h](/abs/path/C:/Users/Kubra/Desktop/kamera/_analysis/sdk/EN-HCNetSDKV6.1.9.4_build20220412_win64/incEn/HCNetSDK.h:22018)
- `NET_DVR_SADPINFO_LIST` [HCNetSDK.h](/abs/path/C:/Users/Kubra/Desktop/kamera/_analysis/sdk/EN-HCNetSDKV6.1.9.4_build20220412_win64/incEn/HCNetSDK.h:22040)
- `NET_DVR_GetSadpInfoList(...)` [HCNetSDK.h](/abs/path/C:/Users/Kubra/Desktop/kamera/_analysis/sdk/EN-HCNetSDKV6.1.9.4_build20220412_win64/incEn/HCNetSDK.h:50844)

Bu alanlar `NET_DVR_SADPINFO` icinde dogrudan mevcut:

- `struIP`
- `wPort`
- `chSerialNo`
- `byMACAddr`
- `byActivated`
- `byDeviceModel`
- `struSubDVRIPMask`
- `struGatewayIpAddr`
- `struDnsServer1IpAddr`
- `struDnsServer2IpAddr`
- `byDhcp`

Sinir:

- `HCNetSDK.h` icinde acik isimli bir `StartSadp`, `SearchSadp`, `DiscoverDevices` veya benzeri ayri kesif baslatma fonksiyonu dogrulamadim.
- Bu nedenle `NET_DVR_GetSadpInfoList` cagrisinin tek basina kesif mi baslattigi, yoksa mevcut SADP havuzunu mu okudugu sadece header'dan kesinlestirilemedi.

### 3. Cihaz IP adresi cakissa bile cihazlari MAC ve seri numarasiyla ayirma

Bu gereksinim veri modeli seviyesinde destekleniyor:

- `NET_DVR_SADPINFO.chSerialNo[16]` [HCNetSDK.h](/abs/path/C:/Users/Kubra/Desktop/kamera/_analysis/sdk/EN-HCNetSDKV6.1.9.4_build20220412_win64/incEn/HCNetSDK.h:22024)
- `NET_DVR_SADPINFO.byMACAddr[MACADDR_LEN]` [HCNetSDK.h](/abs/path/C:/Users/Kubra/Desktop/kamera/_analysis/sdk/EN-HCNetSDKV6.1.9.4_build20220412_win64/incEn/HCNetSDK.h:22026)

Sonuc:

- Ayni IP'yi raporlayan iki cihaz varsa, header seviyesinde MAC ve seri numarasi ile ayrim yapmak mumkun gorunuyor.
- Bu yorum veri alanlarina dayanir; ek algoritma veya hazir “duplicate IP resolver” fonksiyonu dogrulanmamistir.

### 4. Kameranin Active/Inactive durumunu ogrenme

Dogru alan:

- `NET_DVR_SADPINFO.byActivated` [HCNetSDK.h](/abs/path/C:/Users/Kubra/Desktop/kamera/_analysis/sdk/EN-HCNetSDKV6.1.9.4_build20220412_win64/incEn/HCNetSDK.h:22034)

Header yorumu:

- `0-invalid`
- `1-activated`
- `2-not activated`

Ilgili hata kodlari:

- `NET_DVR_ERROR_DEVICE_NOT_ACTIVATED` = `250` [HCNetSDK.h](/abs/path/C:/Users/Kubra/Desktop/kamera/_analysis/sdk/EN-HCNetSDKV6.1.9.4_build20220412_win64/incEn/HCNetSDK.h:772)
- `NET_DVR_ERROR_DEVICE_HAS_ACTIVATED` = `252` [HCNetSDK.h](/abs/path/C:/Users/Kubra/Desktop/kamera/_analysis/sdk/EN-HCNetSDKV6.1.9.4_build20220412_win64/incEn/HCNetSDK.h:774)
- `NET_DVR_ERROR_IPC_NOT_ACTIVATED` = `2199` [HCNetSDK.h](/abs/path/C:/Users/Kubra/Desktop/kamera/_analysis/sdk/EN-HCNetSDKV6.1.9.4_build20220412_win64/incEn/HCNetSDK.h:1683)

### 5. Inactive kamerayi guclu bir admin parolasiyla guvenli sekilde aktive etme

Dogru fonksiyon:

- `NET_DVR_ActivateDevice(char* sDVRIP, WORD wDVRPort, LPNET_DVR_ACTIVATECFG lpActivateCfg)` [HCNetSDK.h](/abs/path/C:/Users/Kubra/Desktop/kamera/_analysis/sdk/EN-HCNetSDKV6.1.9.4_build20220412_win64/incEn/HCNetSDK.h:51295)

Dogru yapi:

- `NET_DVR_ACTIVATECFG` [HCNetSDK.h](/abs/path/C:/Users/Kubra/Desktop/kamera/_analysis/sdk/EN-HCNetSDKV6.1.9.4_build20220412_win64/incEn/HCNetSDK.h:43689)

Yapi alanlari:

- `dwSize`
- `sPassword[PASSWD_LEN]`
- `byLoginMode` yorum: `0-Private 1-ISAPI`
- `byHttps` yorum: `0-not use HTTPS, 1-use HTTPS`

Degerlendirme:

- Header'da gercek aktivasyon API'si mevcut.
- “Secure activation” icin guvenlik seviyesi uygulama tarafinda ureteceginiz benzersiz ve guclu parola ile saglanabilir.
- Ancak SDK icinde ayrica “generate password”, “password policy validate”, “secure activation wizard” gibi ayri bir hazir fonksiyon dogrulanmadi.

### 6. DHCP, IP, subnet, gateway ve DNS ayarlama

Dogru yapilar:

- `NET_DVR_NETCFG_V50` [HCNetSDK.h](/abs/path/C:/Users/Kubra/Desktop/kamera/_analysis/sdk/EN-HCNetSDKV6.1.9.4_build20220412_win64/incEn/HCNetSDK.h:9495)
- `NET_DVR_SINGLE_NETPARAM` [HCNetSDK.h](/abs/path/C:/Users/Kubra/Desktop/kamera/_analysis/sdk/EN-HCNetSDKV6.1.9.4_build20220412_win64/incEn/HCNetSDK.h:30185)
- `NET_DVR_SADPINFO` ve `NET_DVR_UpdateSadpInfo(...)` [HCNetSDK.h](/abs/path/C:/Users/Kubra/Desktop/kamera/_analysis/sdk/EN-HCNetSDKV6.1.9.4_build20220412_win64/incEn/HCNetSDK.h:50845)

Dogru fonksiyonlar:

- `NET_DVR_GetDVRConfig(...)` [HCNetSDK.h](/abs/path/C:/Users/Kubra/Desktop/kamera/_analysis/sdk/EN-HCNetSDKV6.1.9.4_build20220412_win64/incEn/HCNetSDK.h:50699)
- `NET_DVR_SetDVRConfig(...)` [HCNetSDK.h](/abs/path/C:/Users/Kubra/Desktop/kamera/_analysis/sdk/EN-HCNetSDKV6.1.9.4_build20220412_win64/incEn/HCNetSDK.h:50700)
- `NET_DVR_GetDeviceConfig(...)` [HCNetSDK.h](/abs/path/C:/Users/Kubra/Desktop/kamera/_analysis/sdk/EN-HCNetSDKV6.1.9.4_build20220412_win64/incEn/HCNetSDK.h:51136)
- `NET_DVR_SetDeviceConfig(...)` [HCNetSDK.h](/abs/path/C:/Users/Kubra/Desktop/kamera/_analysis/sdk/EN-HCNetSDKV6.1.9.4_build20220412_win64/incEn/HCNetSDK.h:51137)
- `NET_DVR_UpdateSadpInfo(...)` [HCNetSDK.h](/abs/path/C:/Users/Kubra/Desktop/kamera/_analysis/sdk/EN-HCNetSDKV6.1.9.4_build20220412_win64/incEn/HCNetSDK.h:50845)

`NET_DVR_NETCFG_V50` icinde dogrulanan alanlar:

- `struEtherNet[MAX_ETHERNET]`
- `byUseDhcp`
- `struDnsServer1IpAddr`
- `struDnsServer2IpAddr`
- `wHttpPortNo`
- `struGatewayIpAddr`
- `byEnableDNS`

`NET_DVR_SINGLE_NETPARAM` icinde:

- `byUseDhcp`
- `struDevIP`
- `struSubnetMask`
- `struGateway`
- `wDevPort`
- `byMACAddr`

Sinir:

- Hangi komut sabitiyle hangi cihaz tipinde `NET_DVR_NETCFG_V50` okunup yazildigi, header'da tek basina yeterince acik degil.
- `NET_DVR_UpdateSadpInfo` fonksiyonu ve `NET_DVR_SADP_VERIFY` yapisi, login olmadan SADP uzerinden ag bilgisi guncelleme senaryosu icin aday gorunuyor; fakat cagrinin eksiksiz semantigi ayrica dokuman veya test ile dogrulanmali.

### 7. Islem sonucu ve hata kodlarini okuma

Dogru fonksiyonlar:

- `NET_DVR_GetLastError()` [HCNetSDK.h](/abs/path/C:/Users/Kubra/Desktop/kamera/_analysis/sdk/EN-HCNetSDKV6.1.9.4_build20220412_win64/incEn/HCNetSDK.h:50343)
- `NET_DVR_GetLastErrorModelCode(...)` [HCNetSDK.h](/abs/path/C:/Users/Kubra/Desktop/kamera/_analysis/sdk/EN-HCNetSDKV6.1.9.4_build20220412_win64/incEn/HCNetSDK.h:50344)
- `NET_DVR_GetErrorMsg(...)` [HCNetSDK.h](/abs/path/C:/Users/Kubra/Desktop/kamera/_analysis/sdk/EN-HCNetSDKV6.1.9.4_build20220412_win64/incEn/HCNetSDK.h:50345)

C# declare edilmis olanlar:

- `NET_DVR_GetLastError()` [HCNetSDK.cs](/abs/path/C:/Users/Kubra/Desktop/kamera/_analysis/sdk/appsdemo/AppsDemo_build20201230191326/CommonBase/Head/HCNetSDK.cs:6136)
- `NET_DVR_GetErrorMsg(...)` [HCNetSDK.cs](/abs/path/C:/Users/Kubra/Desktop/kamera/_analysis/sdk/appsdemo/AppsDemo_build20201230191326/CommonBase/Head/HCNetSDK.cs:6139)

### 8. C# destegi varsa ilgili ornek; yoksa gerekli P/Invoke tanimlari

Dogrulanan C# sarmalayici:

- [HCNetSDK.cs](/abs/path/C:/Users/Kubra/Desktop/kamera/_analysis/sdk/appsdemo/AppsDemo_build20201230191326/CommonBase/Head/HCNetSDK.cs:6003)

Bu dosyada dogrulanan P/Invoke'lar:

- `NET_DVR_Init` [HCNetSDK.cs](/abs/path/C:/Users/Kubra/Desktop/kamera/_analysis/sdk/appsdemo/AppsDemo_build20201230191326/CommonBase/Head/HCNetSDK.cs:6003)
- `NET_DVR_Cleanup` [HCNetSDK.cs](/abs/path/C:/Users/Kubra/Desktop/kamera/_analysis/sdk/appsdemo/AppsDemo_build20201230191326/CommonBase/Head/HCNetSDK.cs:6013)
- `NET_DVR_GetLastError` [HCNetSDK.cs](/abs/path/C:/Users/Kubra/Desktop/kamera/_analysis/sdk/appsdemo/AppsDemo_build20201230191326/CommonBase/Head/HCNetSDK.cs:6136)
- `NET_DVR_GetDVRConfig` [HCNetSDK.cs](/abs/path/C:/Users/Kubra/Desktop/kamera/_analysis/sdk/appsdemo/AppsDemo_build20201230191326/CommonBase/Head/HCNetSDK.cs:6945)
- `NET_DVR_SetDVRConfig` [HCNetSDK.cs](/abs/path/C:/Users/Kubra/Desktop/kamera/_analysis/sdk/appsdemo/AppsDemo_build20201230191326/CommonBase/Head/HCNetSDK.cs:6948)
- `NET_DVR_GetDeviceConfig` [HCNetSDK.cs](/abs/path/C:/Users/Kubra/Desktop/kamera/_analysis/sdk/appsdemo/AppsDemo_build20201230191326/CommonBase/Head/HCNetSDK.cs:6959)
- `NET_DVR_SetDeviceConfig` [HCNetSDK.cs](/abs/path/C:/Users/Kubra/Desktop/kamera/_analysis/sdk/appsdemo/AppsDemo_build20201230191326/CommonBase/Head/HCNetSDK.cs:6962)
- `NET_DVR_STDXMLConfig` [HCNetSDK.cs](/abs/path/C:/Users/Kubra/Desktop/kamera/_analysis/sdk/appsdemo/AppsDemo_build20201230191326/CommonBase/Head/HCNetSDK.cs:10643)

Kritik eksik:

- Bu C# sarmalayicida `NET_DVR_GetSadpInfoList`, `NET_DVR_UpdateSadpInfo`, `NET_DVR_ActivateDevice`, `NET_DVR_SADPINFO`, `NET_DVR_SADP_VERIFY`, `NET_DVR_ACTIVATECFG` icin dogrudan tanim bulamadim.
- Yani C# destegi genel olarak var, ama sizin kesif/aktivasyon akisi icin ek P/Invoke tanimlari buyuk olasilikla bizim tarafimizdan yazilacak.

## Uygulama akisina gore degerlendirme

### Stage 1 ile dogrudan uyusma

Stage 1 hedefleri:

1. Yerel agdaki cihazlari bulma
2. Model, MAC, seri no, IP, aktivasyon durumu listeleme

Header'dan dogrulanan veri alanlari Stage 1 listelemesi icin yeterli gorunuyor:

- Model: `byDeviceModel`
- MAC: `byMACAddr`
- Seri no: `chSerialNo`
- IP: `struIP`
- Aktivasyon durumu: `byActivated`

Ama tek acik risk su:

- Layer-2 kesfin fiilen nasil tetiklenecegi, sadece `HCNetSDK.h` uzerinden tam net degil.
- Bu nedenle Stage 1 implementasyonuna gecmeden once `NET_DVR_GetSadpInfoList` cagrisi icin manual/dokuman pasajini veya calisan ornegi bulmak gerekir.

### Stage 2 ile uyusma

Stage 2 hedefleri:

1. Inactive cihazi aktive etme
2. Aktivasyonu dogrulama

Destekleyen gercek API:

- `NET_DVR_ActivateDevice`
- `NET_DVR_ACTIVATECFG`
- `NET_DVR_SADPINFO.byActivated`

Bu asama SDK tarafinda muhtemelen yapilabilir gorunuyor.

### Stage 3 ile uyusma

Stage 3 hedefleri:

1. DHCP/ag konfigurasyonu
2. ISAPI baglantisi
3. Hik-Connect etkinlestirme

SDK tarafinda dogrulanan parcalar:

- `NET_DVR_GetDVRConfig`
- `NET_DVR_SetDVRConfig`
- `NET_DVR_GetDeviceConfig`
- `NET_DVR_SetDeviceConfig`
- `NET_DVR_STDXMLConfig`
- `NET_DVR_NETCFG_V50`

Sinir:

- EZVIZ/Hik-Connect enable etmek icin kullanacaginiz minimal XML, bu raporda SDK degil ISAPI tarafidir.
- `NET_DVR_STDXMLConfig` mevcut, ama siz ayrica dogrudan HTTP Digest ile `/ISAPI/System/Network/EZVIZ` cagrisi da planliyorsunuz. Bu teknik olarak ayri bir yol.

### Stage 4 ile uyusma

Stage 4 hedefleri:

1. Backend
2. Hik-Connect Team OpenAPI
3. Web HLS/hls.js

Bu asama SDK incelemesinden ayri.

Guvenlik acisindan mevcut karar dogru:

- `appKey` ve `secretKey` Windows istemciye veya tarayiciya konulmamalidir.
- Bunlar yalnizca backend'de bulunmalidir.

## Dogrulanan hatalar ve durum kodlari

Header'dan dogrudan cikarilan ilgili kodlar:

- `NET_DVR_ERROR_DEVICE_NOT_ACTIVATED` = 250
- `NET_DVR_ERROR_DEVICE_HAS_ACTIVATED` = 252
- `NET_DVR_ERROR_IPC_NOT_ACTIVATED` = 2199
- `NET_DVR_SADP_MODIFY_FALIURE` = 2191
- `NET_DVR_ERR_BAD_DNS` = 797
- `NET_DVR_ERR_DNS_INVALID` = 1457
- `NET_ERR_LAN_NOT_SUP_DHCP_CLIENT_CONFIGURATION` = 1316

Genel dokumanda da “Device is not activated. Activate the device by tools such as SADP before use.” ifadesi yer aliyor; bu, aktivasyon oncesi login/normal kullanimin bloke olabildigini destekliyor.

## C# / PInvoke sonucu

Kesin sonuc:

- SDK C# icin tamamen “yok” degil.
- Ama sizin ihtiyaciniz olan kesif + aktivasyon parcasi mevcut C# wrapper'da hazir olarak gorunmuyor.
- Bu nedenle WPF/.NET 8 uygulamasinda asagidaki P/Invoke tanimlarini elle eklememiz gerekecek:
  - `NET_DVR_GetSadpInfoList`
  - `NET_DVR_UpdateSadpInfo`
  - `NET_DVR_ActivateDevice`
  - `NET_DVR_SADPINFO`
  - `NET_DVR_SADPINFO_LIST`
  - `NET_DVR_SADP_VERIFY`
  - `NET_DVR_ACTIVATECFG`

Bu tanimlar header'dan birebir cikarilabilir; uydurma API gerekmiyor.

## Bu turda kesinlestirilen sinirlar

- `HCNetSDK.h` icinde acik isimli bir SADP kesif baslatma fonksiyonu dogrulanmadi.
- `AppsDemo` icindeki `HCNetSDK.cs` dosyasinda SADP ve aktivasyon P/Invoke'lari bulunmadi.
- `ConfigCSharpDemo` arsivi bu ortamda tam saglikli kaynak taramasina elvermedi; bin klasoru kesin dogrulandi, ama bu raporda oradan ilave API iddiasi uretilmedi.
- Secure activation icin ekstra “hazir sihirli fonksiyon” dogrulanmadi; yalnizca `NET_DVR_ActivateDevice` dogrulandi.

## Aşama 1 icin karar

Kod yazmadan onceki sonuc:

- Aşama 1 icin gereken veri modeli ve temel SDK giris/hatayi okuma fonksiyonlari mevcut.
- En kritik teknik belirsizlik, `NET_DVR_GetSadpInfoList` ile kesfin nasil tetiklenecegi.
- Bu nedenle Aşama 1 implementasyonuna gecmeden once bir sonraki adim:
  - genel dokumanda `NET_DVR_GetSadpInfoList` ve `NET_DVR_UpdateSadpInfo` fonksiyon basliklarini bulmak,
  - yoksa header'a sadik kalarak minimal P/Invoke ile prototip WPF kesif ekranini yazip gercek cihaz/ortamda test etmek.

## Bu turda olusturulan dosyalar

- [SDK_INCELEME_RAPORU.md](/abs/path/C:/Users/Kubra/Desktop/kamera/SDK_INCELEME_RAPORU.md:1)
- `_analysis/sdk/...` altinda analiz icin cikartilan kopyalar
