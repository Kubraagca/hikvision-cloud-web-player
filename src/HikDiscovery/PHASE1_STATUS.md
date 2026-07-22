# Aşama 1 Durum Notu

Tarih: 2026-07-22

## Doğrulananlar

- `HCNetSDK.h` içindeki gerçek imzalardan şu P/Invoke tanımları eklendi:
  - `NET_DVR_GetSadpInfoList`
  - `NET_DVR_UpdateSadpInfo`
  - `NET_DVR_ActivateDevice`
  - `NET_DVR_SADPINFO`
  - `NET_DVR_SADPINFO_LIST`
  - `NET_DVR_SADP_VERIFY`
  - `NET_DVR_ACTIVATECFG`
- Çağrı kuralı `__stdcall` olduğundan `CallingConvention.StdCall` kullanıldı.
- Projeler yalnızca `x64` hedefleyecek şekilde ayarlandı.
- `Marshal.SizeOf` sonuçları header yerleşimiyle eşleşti:
  - `NET_DVR_IPADDR = 144`
  - `NET_DVR_SADPINFO = 956`
  - `NET_DVR_SADPINFO_LIST = 244748`
  - `NET_DVR_SADP_VERIFY = 224`
  - `NET_DVR_ACTIVATECFG = 128`
- SDK runtime dosyaları için geçerli kaynak olarak:
  - `third_party/hcnetsdk_fixed/EN-HCNetSDKV6.1.9.4_build20220412_win64/lib`
  kullanılıyor.
- Console test projesi self-contained `win-x64` olarak publish edildi ve gerçek `HCNetSDK.dll` ile çalıştırıldı.
- `NET_DVR_Init`, `NET_DVR_SetLogToFile` ve `NET_DVR_Cleanup` zinciri çalıştı.

## Gerçek Çalışma Sonucu

Console testi sırasında `NET_DVR_GetSadpInfoList` çağrısı 8 kez tekrarlandı.

Her çağrıda sonuç:

- `NET_DVR_GetLastError = 47`
- `NET_DVR_GetErrorMsg = User doest not exist. The user ID has been logged out or unavailable.`

Bu sonuç, SDK'nın bu fonksiyon için verilen `lUserID` değerini geçerli bir oturum olarak beklediğini gösteriyor.

## SDK Örneğiyle Eşleştirme

`ClientDemo/DlgQuickAddIpc.cpp` içinde:

- `NET_DVR_GetSadpInfoList(m_lServerID, &m_struSadpInfoList)` çağrılıyor.
- `m_lServerID` varsayılanı `-1`.

`ClientDemo/ClientDemoDlg.cpp` içinde:

- `dlg.m_lServerID = g_struDeviceInfo[dlg.m_iDevIndex].lLoginID;`

Bu örnek akış, `NET_DVR_GetSadpInfoList` fonksiyonunun doğrudan yerel PC broadcast taraması gibi değil, giriş yapılmış bir cihaz oturumu (`lLoginID`) bağlamında kullanıldığını gösteriyor.

## Sonuç

- Yerel ağdaki kameraları PC tarafından doğrudan tarayan ayrı bir `NET_DVR_*` discovery-start fonksiyonu bu incelemede bulunmadı.
- `NET_DVR_GetSadpInfoList` için `lUserID = 0` ile çalışır bir yerel broadcast keşfi doğrulanamadı.
- Bu nedenle Aşama 1'de istenen "aynı yerel ağdaki kameraları doğrudan bulma" davranışı mevcut SDK bulgularıyla doğrulanmış değildir.
- `NET_DVR_ActivateDevice` henüz çağrılmadı.
- Aktivasyon butonu veya aktivasyon akışı doğrulanmış sayılmamalıdır.

## Oluşturulan Projeler

- `src/HikDiscovery/HikSdk.Interop`
- `src/HikDiscovery/HikSdk.SadpConsole`
- `src/HikDiscovery/HikSdk.SadpWpf`

## Önemli Not

İlk denemelerde çalışma alanına çıkarılmış bazı DLL kopyaları sıfır içerikliydi. Bu durum düzeltildi; mevcut publish çıktısı gerçek PE dosyalarını kullanıyor. Şu anki blokaj native yükleme değil, `NET_DVR_GetSadpInfoList` çağrısının oturum beklentisidir.
