# Proje Detayli Dokuman

## 1. Projenin Amaci

Bu workspace, Hikvision ekosisteminde birbirine bagli birden fazla ihtiyaci tek yerde toplar:

1. Hikvision / HikCentral Connect Team OpenAPI uzerinden cloud kamera listesini almak
2. Secilen kameranin canli yayin bilgisini alip tarayicida oynatmak
3. Gerekirse HLS yerine Hikvision `JSDecoder / EZOPEN` akisini kullanmak
4. Yerel agdaki bir kamerayi aktive etmek
5. Kamera network ayarlarini (gateway, DNS, DHCP) duzenlemek
6. Kamerada Hik-Connect / EZVIZ kaydini acmak
7. Kamerayi Team hesabina eklemek
8. Kamera kanallarini ilgili area altina tasimak
9. Bu yerel isleri Windows agent veya native/SDK yardimcilariyla yapmak

Kisaca bu repo tek bir "video izleme demosu" degil; cloud playback, yerel provisioning, Team cihaza ekleme ve Windows agent paketleme islerini birlikte tasiyan hibrit bir entegrasyon deposu.

## 2. Buyuk Resim

Projede dort ana calisma modu vardir:

1. `Cloud izleme modu`
   `index.html` -> Node backend -> Hikvision OpenAPI -> HLS veya EZOPEN stream bilgisi

2. `Backend uzerinden Team'e cihaz ekleme modu`
   `team-device-add.html` -> Node backend -> Team OpenAPI -> area bul/olustur -> cihaz ekle -> kanallari area'ya bagla

3. `Sunucudan yerel provisioning modu`
   `provisioning.html` -> Node backend -> ISAPI + HCNetSDK helper -> kamera aktivasyon ve cloud kaydi

4. `Windows yerel agent modu`
   Browser -> yerel agent `127.0.0.1:47831` -> HCNetSDK + ISAPI -> backend -> Team kaydi

Bu mimaride kritik ilke su:

- Team OpenAPI `AK/SK`, token, backend business logic sunucu tarafinda kalir.
- Kamera aktivasyonu ve yerel ag islemleri ya ayni LAN'daki backend uzerinden ya da ayni LAN'daki Windows agent uzerinden yapilir.
- Frontend yalnizca kendi backend'ine veya yerel agent'e konusur; Hikvision cloud sirlarini dogrudan almaz.

## 3. Ana Teknolojiler

- Node.js 18+
- Express
- Tarayici tarafinda `hls.js`
- Hikvision `JSDecoder / jsPlugin`
- Hikvision Team OpenAPI
- Hikvision ISAPI
- HCNetSDK
- .NET tarafinda Windows agent ve CLI/WPF/interop projeleri
- Linux tarafinda native helper (`native/hik_activation_helper_linux`)

## 4. Klasor ve Dosya Haritasi

### Kök seviye ana dosyalar

- `server.js`
  Node/Express uygulamasinin ana giris noktasi

- `lib/team-openapi-service.js`
  Team OpenAPI icin tum token, area, cihaz ekleme ve kanal aktarim mantigi

- `index.html`
  Cloud kamera listesi ve canli yayin izleme arayuzu

- `provisioning.html`
  Yerel agent ekranina kopru olan kurulum sayfasi

- `team-device-add.html`
  Sadece backend uzerinden Team kaydi yapan form ekrani

- `browser-network-test.html`
  Tarayici ile kameraya dogrudan erisim/CORS/LNA davranisini test eder

- `jsdecoder-demo.html`
  EZOPEN/jsDecoder oynatma tarafinda kullanilan gomulu oyuncu/demo sayfasi

- `README.md`
  Kisa kurulum ve temel akislari anlatir

- `PROJE_DETAYLI_DOKUMAN.md`
  Bu dosya

### Node tarafina destek veren klasorler

- `lib/`
  OpenAPI servis katmani

- `test/`
  Node tarafi mock tabanli testler

- `scripts/`
  Agent paketleme scriptleri

- `sdk/`
  Hikvision JSDecoder/WASM dagitim dosyalari

- `native/`
  Linux native aktivasyon helper kaynagi

### .NET tarafi

`src/HikDiscovery` altinda birden fazla alt proje vardir:

- `HikProvisioning.Agent`
  Windows'ta localhost uzerinden calisan yerel agent

- `HikProvisioning.Web`
  Agent paketinin web asset ciktilariyla ilgili alan

- `HikSdk.Interop`
  HCNetSDK P/Invoke katmani

- `HikSdk.ProvisioningCli`
  Agent'in cagirabildigi CLI yardimcisi

- `HikSdk.SadpConsole`
  Console tabanli SADP/aktivasyon yardimcilari

- `HikSdk.SadpWpf`
  WPF tabanli masaustu arayuzu / deneysel yerel provisioning araci

- `HikConnect.TeamBackend`
  .NET tarafli backend denemeleri veya alternatif servis iskeleti

### SDK ve vendor dosyalari

- `third_party/hcnetsdk`
- `third_party/hcnetsdk_fixed`
- `third_party/hcnetsdk_linux64`

Bunlar HCNetSDK runtime ve platforma ozel dosyalari tutar.

### Arastirma ve cikti klasorleri

- `analysis/`
- `_analysis/`
- `artifacts/`

Buralar aktif uygulama runtime'inin merkezi degil; analiz, paketleme ve build ciktisi agirliklidir.

## 5. Ortam Degiskenleri

Node backend icin temel degiskenler:

- `HIK_APP_KEY`
  Hikvision / HikCentral Connect uygulama anahtari

- `HIK_APP_SECRET`
  uygulama gizli anahtari

- `HIK_INITIAL_SERVER`
  varsayilan: `https://ieu.hikcentralconnect.com`

- `PORT`
  varsayilan: `3000`

Kimlik bilgileri eksikse backend pek cok endpointte kontrollu hata doner.

## 6. Node Backend Mimarisi

Ana uygulama `server.js` icinde kurulur.

Baslangicta yapilan temel isler:

1. Express olusturulur
2. JSON body parser tanimlanir
3. `HIK_APP_KEY` ve `HIK_APP_SECRET` environment'tan okunur
4. `createTeamOpenApiService(...)` ile servis katmani initialize edilir
5. COEP / COOP / CORP header'lari eklenir
6. Statik dosyalar servis edilir
7. `/sdk` altina SDK dosyalari mount edilir
8. API route'lari tanimlanir

### 6.1 Onbellekler

Node tarafinda iki ana cache vardir:

- `tokenCache`
  OpenAPI access token ve `areaDomain` saklar

- `streamTokenCache`
  Stream tarafinda kullanilan app token/app key/domain bilgisini saklar

Ek olarak:

- `streamCache`
  Stream URL cevaplarini cache'ler

- `provisioningTasks`
  Uzun suren provisioning gorevlerinin durum bilgisini tutar

### 6.2 Guvenlik ve maskeleme

`sanitizeMessage(...)` ile su bilgiler log/hata ciktilarinda maskelenir:

- app key
- app secret
- password
- userName
- token
- accessToken

Bu tasarim repo genelinde gorulen onemli bir prensiptir: gizli degerlerin frontend'e veya loglara sizmamasi.

## 7. Team OpenAPI Servis Katmani

`lib/team-openapi-service.js` projenin cloud business logic merkezidir.

Bu dosya su sorumluluklari alir:

1. token alma
2. token yenileme
3. area domain uzerinden OpenAPI istegi gonderme
4. area listeleme
5. area yoksa olusturma
6. cihaz detayi sorgulama
7. Team hesabina cihaz ekleme
8. kanal alan aktarimi
9. stream encryption kapatma

### 7.1 Token akisi

`getToken(forceRefresh = false)` su mantikla calisir:

1. `HIK_APP_KEY` / `HIK_APP_SECRET` yoksa hata firlatir
2. cache'deki token halen gecerliyse onu kullanir
3. degilse `INITIAL_SERVER/api/hccgw/platform/v1/token/get` endpointine gider
4. donen `accessToken`, `areaDomain`, `expireTime` bilgilerini cache'e yazar

Bu `areaDomain`, sonraki tum resource endpointlerinin baz adresi olur.

### 7.2 OpenAPI istegi

`postOpenApi(...)`:

1. token alir
2. `Token` header'i ile ilgili `areaDomain + pathName` adresine POST atar
3. `OPEN000007` gelirse tokeni bir kez force refresh ile yeniler
4. yine hata varsa bunu guvenli mesajla yuzeye cikarir

### 7.3 Area mantigi

`ensureArea(areaName)` su sekilde davranir:

1. mevcut area'lari alir
2. ayni isimli bir area varsa onu doner
3. yoksa `areas/add` ile olusturur
4. donen area ID yetersizse area listesini tekrar ceker

### 7.4 Cihaz ekleme mantigi

`addDeviceAndImportChannels(...)` bu projenin en kritik akislardan biridir:

1. once `devicedetail/get` ile cihaz daha once Team hesabinda var mi kontrol edilir
2. cihaz yoksa `devices/add` ile eklenir
3. `importToArea.enable=1` sayesinde ilk ekleme sirasinda area iliskisi de kurulmaya calisilir
4. cihaz detayindan `cameraChannel` listesi okunur
5. stream encryption fiziksel resource modify endpoint'iyle kapatilir
6. cihaz daha once vardiysa eksik kanallar `areas/resources/add` ile area'ya eklenir

### 7.5 Hata kodu yorumlama

`friendlyOpenApiError(...)` bazi Hikvision hata kodlarini anlamli metne cevirir:

- `OPEN000007`
  token hatasi

- `LAP000001`
  parametre hatasi

- `EVZ20007`
  cihaz cloud tarafinda offline

- `EVZ20010`
  verification code hatali

- `EVZ20013`
  cihaz baska bir hesaba bagli

## 8. Izleme Akisi

### 8.1 Kullanici akisinin giris noktasi

Kullanici `http://localhost:3000/` acinca `index.html` yuklenir.

Bu sayfa:

1. `/api/health` ile backend hazir mi kontrol eder
2. `/api/sdk-config` ile SDK stream bilgilerini almaya calisir
3. `/api/cameras` ile cloud kamera listesini ceker
4. secilen kamera icin `/api/stream` endpointini cagirir
5. stream protokolune gore ya HLS ya EZOPEN/jsDecoder yoluna gider

### 8.2 `GET /api/health`

Bu endpoint:

- backend AK/SK ayarli mi
- token alinabiliyor mu
- `areaDomain` ne
- `sdkInstalled` durumu ne

gibi temel saglik bilgisini dondurur.

### 8.3 `GET /api/cameras`

Bu endpoint su OpenAPI yolunu kullanir:

- `/api/hccgw/resource/v1/areas/cameras/get`

Backend gelen veri icinden su sade modeli uretir:

- `name`
- `online`
- `resourceId`
- `cameraIndexCode`
- `deviceSerial`
- `channelNo`

Frontend listedeki kartlari bu cevaptan uretir.

### 8.4 `GET /api/stream`

Bu endpoint secilen cihaz icin stream kaynagini ister.

Query parametreleri:

- `resourceId`
- `deviceSerial`
- `quality`
- `protocol`
- opsiyonel `code` (verification code)

Davranis:

1. stream source backend tarafinda alinir/cache'lenir
2. `protocol=2` ise HLS yolu tercih edilir
3. HLS manifest proxylenerek tarayiciya verilir
4. `protocol=1` ise EZOPEN/jsDecoder tarafina uygun stream cevabi dondurulur

### 8.5 HLS akisinin detaylari

HLS akisi iki yardimci endpoint daha kullanir:

- `GET /api/hls/manifest`
- `GET /api/hls/chunk`

Buradaki amac upstream HLS manifestini alip lokal URL'lere rewrite etmektir. Boylece tarayici dogrudan Hikvision'un verdigi parca linklerine degil, bizim backend uzerinden akan manifest/chunk zincirine baglanir.

Bu sayede:

- CORS sorunlari azalir
- upstream adres gizlenir
- cache ve kontrol backend'te kalir

### 8.6 EZOPEN / JSDecoder akisinin detaylari

`index.html` uzerinde kullanici:

- `Otomatik`
- `HLS`
- `EZOPEN + SDK`

modlarindan birini secebilir.

Akis:

1. HLS seciliyse once HLS denenir
2. encryption sorunu cikarsa ve verification code varsa SDK fallback devreye girebilir
3. SDK oynatma `jsdecoder-demo.html` icine `iframe` ile gecilir
4. Bu iframe `resourceId`, `deviceSerial`, `channelNo`, `quality`, `code` gibi parametreleri query string ile alir

`index.html` ayni zamanda `/sdk/dist/jsPlugin-3.0.0.min.js` yukler. Bu repo Hikvision'un browser SDK dosyalarinin proje altina elle konmasini bekler.

## 9. Team'e Kamera Ekleme Akisi

Bu akis `team-device-add.html` uzerinden baslar.

### 9.1 Frontend davranisi

Kullanici su alanlari doldurur:

- `shortSerial`
- `verificationCode`
- `alias`
- `areaName`
- opsiyonel `userName`
- opsiyonel `password`

Sayfa sadece su endpoint'e POST eder:

- `POST /api/team-devices/add`

### 9.2 Backend davranisi

Node backend:

1. `shortSerial` ve `verificationCode` kontrolu yapar
2. `teamOpenApiService.addDeviceToAreaWorkflow(...)` cagirir
3. servis tarafinda area bulunur/olusturulur
4. cihaz Team'e eklenir veya mevcut cihaz teyit edilir
5. stream encryption kapatilir
6. eksik kanallar area'ya baglanir

### 9.3 Guvenlik modeli

Bu ekranda onemli nokta:

- frontend Hikvision OpenAPI'yi dogrudan cagirmiyor
- AK/SK tarayiciya inmiyor
- token tarayiciya inmiyor
- is mantigi backend'te kaliyor

## 10. Sunucudan Yerel Provisioning Akisi

`POST /api/provision/start` ile backend tabanli provisioning gorevi baslatilabilir.

Istek alanlari:

- `cameraIp`
- `userName`
- `password`
- `areaName`
- `gatewayOverride`
- `sdkPort`
- `enableDhcp`

Bu endpoint:

1. bir `taskId` uretir
2. gorevi `provisioningTasks` map'ine kaydeder
3. `runProvisioningTask(...)` isimli asenkron akisi baslatir
4. istemciye `202 Accepted` ve `taskId` doner

Durum takip endpoint'i:

- `GET /api/provision/tasks/:taskId`

### 10.1 Provisioning asamalari

Node tarafindaki gorev asamalari soyledir:

1. `Erisim`
2. `Aktivasyon`
3. `Cihaz Bilgileri`
4. `Ag Ayarlari`
5. `Hik-Connect Ayari`
6. `Team Hesabina Ekleme`
7. `Kanal Aktarimi`
8. `Tamamlandi`

### 10.2 Aktivasyon mantigi

Akis genel olarak soyledir:

1. kamera `/ISAPI/System/activateStatus` ile okunur
2. inactive ise HCNetSDK helper cagrilir
3. aktivasyon sonrasi `/ISAPI/System/deviceInfo` tekrar tekrar denenir
4. cihaz bilgileri okununca akisin geri kalani devam eder

Node bu noktada iki farkli helper mantigi barindirir:

- Linux icin native helper binary
- Windows icin `HikSdk.SadpConsole` veya `dotnet run` fallback

### 10.3 ISAPI mantigi

Node tarafinda ISAPI icin digest auth yardimcilari vardir:

- `parseDigestChallenge`
- `buildDigestAuthorization`
- `fetchWithDigest`

Bu katman su endpointleri kullanir:

- `/ISAPI/System/activateStatus`
- `/ISAPI/System/deviceInfo`
- `/ISAPI/System/Network/interfaces`
- `/ISAPI/System/Network/EZVIZ`

### 10.4 Network guncelleme

Backend:

1. mevcut network XML'ini ceker
2. gateway degerini cikarir veya tahmin eder
3. DNS'i `8.8.8.8` ve `1.1.1.1` yapar
4. `enableDhcp` acikse DHCP modunu acar
5. XML'i PUT eder

DHCP acildiysa cihazin IP'si degisebilir. Bu nedenle backend subnet taramasi yaparak cihazi tekrar bulmaya calisir.

### 10.5 EZVIZ / Hik-Connect aktivasyonu

Akis:

1. `/ISAPI/System/Network/EZVIZ` XML'i okunur
2. yeni bir verification code uretilir veya mevcut kullanilir
3. `enabled=true`
4. `streamEncrypteEnabled=false`
5. `convergenceCloudEnabled=false`
6. guncel XML PUT edilir
7. `registerStatus=true` olana kadar poll edilir

Iki dakika icinde `registerStatus=true` olmazsa gorev hata verir.

### 10.6 Team'e ekleme

EZVIZ online olduktan sonra backend ayni gorev icinde cloud tarafa gecer:

1. area secer/olusturur
2. alias uretir
3. Team'e cihazi ekler
4. kanallari area altina aktarir

Yani provisioning gorevi yalnizca yerel ayar degil; cloud onboarding isini de sonlandirabilir.

## 11. Windows Yerel Agent Mimarisi

Bu repo, ayni LAN'da calisan bir Windows bilgisayara kurulabilen yerel bir agent de icerir.

Agent sabit olarak su adreste dinler:

- `http://127.0.0.1:47831`

Ana kaynak dosya:

- `src/HikDiscovery/HikProvisioning.Agent/Program.cs`

### 11.1 Agent neden var?

Tarayici ile kameraya dogrudan erisim her zaman guvenilir degildir. Sebepler:

- CORS
- Chrome Local Network Access kisitlari
- kamera preflight destegi eksikligi
- digest auth sinirlari
- HCNetSDK'nin browser tarafinda calismamasi

Bu nedenle agent:

- ayni Windows makinede
- localhost uzerinden
- kullanicinin tarayicisina yakin ama kameraya LAN seviyesinde erisebilen

bir arakatman gorevi gorur.

### 11.2 Agent route'lari

Agent uzerindeki ana route'lar:

- `GET /agent/health`
- `POST /agent/discover`
- `POST /agent/provision/start`
- `POST /agent/cloud-register/start`
- `POST /agent/connect/start`
- `GET /agent/tasks/{taskId}`
- `POST /agent/tasks/{taskId}/cancel`

### 11.3 Agent gorev tipleri

Agent tarafinda uc ana gorev akisi vardir:

1. `localSetup`
   Kamera aktivasyonu + network + encryption kapatma + EZVIZ online etme

2. `cloudRegister`
   Kamerayi once local olarak hazir varsayip backend uzerinden Team kaydi

3. `connect`
   Hafif mod: aktivasyon gerekirse yap, login ve encryption durumunu kontrol et

### 11.4 Agent icindeki lokal tarama

`LocalDiscoveryService.cs` yerel subnet taramasini yapar.

Mantik:

1. once oncelikli IP'ler denenir
   `192.168.1.64`, `192.168.0.64`, `192.168.1.65` gibi

2. sonra sistem network adapter'larindan private subnetler cikarilir

3. sanal adapter'lar elenir
   Hyper-V, Docker, VMware, WSL, Tailscale vb.

4. hostlar ICMP + TCP 80 + TCP 554 + TCP 8000 acisindan probe edilir

5. port 80 aciksa ISAPI endpointleri denenir

6. su ipuclarindan biri varsa cihaz "kamera olabilir" diye kabul edilir:
   Hikvision response izi
   RTSP portu
   SDK portu
   `.64` / `.65` gibi yaygin host'lar

Bu servis tam SADP degil; daha cok hizli yerel network heuristics taramasidir.

### 11.5 Agent'in kamera ile konusma sekli

`AgentCameraRuntime.cs` icindeki `AgentCameraIsapiClient` sinifi:

- digest auth kullanir
- `deviceInfo` okur
- `activateStatus` okur
- network XML gunceller
- DHCP sonrasi cihazin yeni IP'sini bulmaya calisir
- EZVIZ acip `registerStatus` poll eder

Node tarafindaki ISAPI yardimcilariyla ayni mantigin .NET uyarlamasidir.

### 11.6 Agent'in backend ile konusma sekli

`AgentTeamBackendClient`:

1. verilen `BackendUrl` adresine baglanir
2. saglik kontrolu yapar
3. `api/team-devices/add` endpoint'ine POST eder

Yani agent cloud business logic'i kendi icinde tekrar yazmaz; onu backend'e delege eder.

## 12. HCNetSDK ve Aktivasyon Katmani

Repo icinde HCNetSDK ile ilgili birden fazla uygulama izi vardir:

- Node'un helper cagirisi
- .NET interop
- .NET CLI
- .NET WPF
- Linux native helper

Bu katmanin ana gorevi:

- inactive kamerayi aktive etmek
- login olup stream encryption bilgisini okumak
- gerekirse stream encryption kapatmak

### 12.1 WPF / Console / CLI projeleri neden var?

Bu repo sadece tek nihai uygulamaya degil, ayni zamanda arastirma ve gecis asamalarina da ev sahipligi yapiyor. `src/HikDiscovery/PHASE1_STATUS.md` dosyasi bunun izlerini tasiyor.

Bu dosya su gercegi gosteriyor:

- SADP tarafi dogrudan beklenildigi kadar basit cikmamis
- `NET_DVR_GetSadpInfoList` kullanimi uzerinde denemeler yapilmis
- discovery ve aktivasyon davranisi asama asama dogrulanmis

Yani repo, "tek seferde yazilmis temiz urun" degil; sahada denene denene buyumus bir entegrasyon deposu.

## 13. Local Agent Paketleme Akisi

`scripts/Publish-LocalAgent.ps1` su isi yapar:

1. once eski `artifacts/local-agent` ve download ciktilarini temizler
2. `HikProvisioning.Agent` ve `HikSdk.ProvisioningCli` build ciktisini alir veya mevcut ciktiyi kullanir
3. bundle klasoru olusturur
4. `start-agent.cmd`, `start-agent.ps1`, `install-agent.ps1`, `install-agent.cmd`, `install-agent-silent.cmd` dosyalarini yazar
5. README olusturur
6. bundle'i zipler
7. IExpress icin `payload.zip` ve `install-from-package.cmd` uretir
8. `.sed` dosyasi yazar
9. Windows setup EXE'si cikarir

Uretilen iki temel artifact:

- `HikProvisioning.Agent-win-x64.zip`
- `HikProvisioning.Agent-win-x64-Setup.exe`

Bu paketler backend tarafinda su route'larla dagitilir:

- `/downloads/local-agent/HikProvisioning.Agent-win-x64.zip`
- `/downloads/local-agent/HikProvisioning.Agent-win-x64-Setup.exe`

## 14. Tarayici Test Sayfasinin Rolü

`browser-network-test.html` sahte bir demo degildir; dogrudan browser-kamera erisimini test etmek icin var.

Iki test yapar:

1. basit `GET /ISAPI/System/activateStatus`
2. custom header ile preflight tetikleyen GET

Amaci su sorulara net cevap vermektir:

- browser local kameraya dogrudan konusabiliyor mu
- CORS engeli var mi
- Local Network Access kisiti var mi
- preflight engelleniyor mu

Bu sayfa agent mimarisinin neden gerekli oldugunu dogrulamak icin de kullanilabilir.

## 15. Test Altyapisi

`test/team-openapi-service.test.js` mock fetch uzerinden su senaryolari test eder:

1. token yenileme
2. cihaz ekleme akisi
3. area yoksa olusturma
4. mevcut cihazda eksik kanal importu
5. Hikvision hatalarinin guvenli sekilde yuzeye cikarilmasi

Bu testler gercek Hikvision API'sine cikmaz; unit/integration benzeri mock testtir.

## 16. Uygulamanin Baslica Veri Akislari

### 16.1 Cloud izleme

1. Kullanici `index.html` acar
2. frontend `/api/cameras` ister
3. backend OpenAPI'den kamera listesini alir
4. kullanici kamerayi secer
5. frontend `/api/stream` ister
6. backend stream URL alir
7. HLS ise manifest proxylenir
8. EZOPEN ise jsDecoder iframe'e gecilir
9. tarayici yayini oynatir

### 16.2 Team'e cihaz ekleme

1. Kullanici `team-device-add.html` acip formu doldurur
2. frontend `/api/team-devices/add` cagirir
3. backend area bulur/olusturur
4. cihazi ekler veya mevcut oldugunu dogrular
5. stream encryption kapatir
6. eksik kanallari area'ya aktarir
7. sonucu frontend'e dondurur

### 16.3 Sunucudan provisioning

1. frontend provisioning istegi gonderir
2. backend task olusturur
3. kamera aktif mi kontrol edilir
4. gerekirse HCNetSDK ile aktivasyon yapilir
5. `deviceInfo` okunur
6. network ayarlari uygulanir
7. EZVIZ aktif edilir
8. `registerStatus=true` beklenir
9. Team kaydi yapilir
10. task sonucu saklanir

### 16.4 Agent tabanli provisioning

1. Kullanici `/camera-setup` ekranini acar
2. sayfa yerel agent'i kontrol eder
3. agent kuruluysa `camera-setup.html` ekranina gecilir
4. agent lokal tarama veya manuel IP ile kamerayi bulur
5. HCNetSDK + ISAPI ile lokal ayarlar yapilir
6. gerekiyorsa backend'e cloud kaydi devredilir

## 17. Kritik Tasarim Kararlari

### 17.1 Gizli bilgileri frontend'e vermemek

Bu depoda cok belirgin bir karar var:

- OpenAPI AK/SK backend'te kalir
- token backend'te kalir
- verification code ve sifre loglarda maskelenmeye calisilir

### 17.2 HLS ile EZOPEN'i birlikte desteklemek

HLS tek basina yeterli degil cunku:

- bazi streamler encrypted gelebilir
- tarayici uyumsuzluklari olabilir
- Hikvision'un kendi player akisina gecmek gerekebilir

Bu nedenle repo cift yol tasir:

- kolay yol: HLS
- zor ama resmi yol: JSDecoder/EZOPEN

### 17.3 Browser yerine agent kullanmak

Tarayici-kamera dogrudan baglantisi kirmizi cizgiler tasidigi icin kritik yerel isler localhost agent'e tasinmis.

### 17.4 Aktivasyon ve cloud kaydi ayri ama birlesebilir

Proje aktivasyon, network, EZVIZ ve Team kaydini ayri adimlar olarak modeller. Ama isterse bunlari tek bir uzun provisioning gorevinde birlestirebilir.

## 18. Sinirlar ve Dikkat Edilecek Noktalar

1. Repo icinde cok sayida build output ve vendor dosyasi vardir; aktif kaynak kod ile artifact'lari karistirmamak gerekir.
2. HLS her ortamda calismayabilir; stream encryption veya codec kisitlari olabilir.
3. SDK dosyalari elle `sdk/` altina konmadiysa jsDecoder akisi calismaz.
4. Yerel provisioning icin backend'in veya agent'in kamerayla ayni agda olmasi gerekir.
5. DHCP acildiginda kamera IP'si degisebilir; sistem bunu tekrar bulmaya calisir ama fiziksel ag kosullari belirleyicidir.
6. Team tarafinda cihaz baska hesaba bagliysa ekleme akisi durur.
7. `registerStatus=true` olmadan cloud onboarding tamamlanmis sayilmaz.

## 19. Bu Repo'ya Bakarken Nasil Okunmali?

Projeyi anlamak icin en dogru okuma sirasi sudur:

1. `README.md`
2. `server.js`
3. `lib/team-openapi-service.js`
4. `index.html`
5. `team-device-add.html`
6. `provisioning.html`
7. `src/HikDiscovery/HikProvisioning.Agent/Program.cs`
8. `src/HikDiscovery/HikProvisioning.Agent/AgentCameraRuntime.cs`
9. `src/HikDiscovery/HikProvisioning.Agent/LocalDiscoveryService.cs`
10. `scripts/Publish-LocalAgent.ps1`
11. `test/team-openapi-service.test.js`

Bu sira, "kullanicinin gordugu ekran"dan baslayip "yerel ag + SDK + paketleme" ayrintisina inen en dengeli yoldur.

## 20. Sonuc

Bu proje tek katmanli bir web uygulamasi degildir. Uc katmanli bir entegrasyon yapisi vardir:

1. `Web UI`
   Izleme, Team ekleme ve agent kopru ekranlari

2. `Node backend`
   OpenAPI, HLS proxy, gorev yonetimi, provisioning orkestrasyonu

3. `Yerel runtime`
   Windows agent, HCNetSDK, ISAPI, CLI/WPF/native helper katmani

Temel misyon su sekilde ozetlenebilir:

"Bir Hikvision kamerayi yerel agda hazir hale getir, cloud tarafinda online yap, Team hesabina ekle ve sonrasinda canli yayini hem HLS hem de resmi SDK akisiyla oynat."
