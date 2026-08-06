HikProvisioning.Agent

1. HikProvisioning.Agent-win-x64-Setup.exe dosyasina cift tiklayin.
2. Alternatif olarak zip paketini acip install-agent.cmd dosyasina bir kez cift tiklayin.
3. Kurulum dosyalari su klasore kopyalanir:
   %LOCALAPPDATA%\HikProvisioningAgent
4. Masaustune kisayol birakilir ve agent baslatilir.
5. Agent localhost uzerinde su adreste dinler:
   http://127.0.0.1:47831
6. Ardindan web panelde /LocalAgent sayfasini acin.

Notlar:
- Bu paket HikSdk.ProvisioningCli ve gerekli HCNetSDK dosyalarini icerir.
- Kamera ile ayni yerel agdaki Windows bilgisayarda calismalidir.
- Parola, token, AK/SK ve verification code degerlerini loglamayin.
