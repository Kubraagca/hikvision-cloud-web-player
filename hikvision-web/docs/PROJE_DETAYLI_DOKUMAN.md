# Proje Detayli Dokuman

## 1. Projenin Amaci

Bu proje, Hikvision ekosistemindeki iki farkli ihtiyaci tek bir uygulamada birlestirir:

1. Cloud tarafinda kamera listeleme ve izleme
2. Yerel agdaki kameralar icin kurulum, aktivasyon ve Team'e baglama

Kisaca proje:

- HikCentral Connect Team OpenAPI ile konusur
- cloud stream alir
- gerekli oldugunda JSDecoder / EZOPEN oynatma yolunu kullanir
- yerel agdaki kameranin ilk aktivasyonunu yapar
- kamera ag ayarlarini duzenler
- Hik-Connect / EZVIZ kaydini acar
- kamerayi Team hesabina ekler

Bu repo yalnizca bir player demosu degildir. Cloud izleme, cihaz provisioning, Team ekleme ve cihaz detay yonetimini bir arada tasiyan hibrit bir entegrasyon reposudur.

## 2. Buyuk Resim

Projede dort ana kullanim alani vardir:

### A. Izleme

`/` uzerinden:

- cloud kamera listesi gelir
- secilen kamera izlenir
- gerekirse PTZ veya cihaz detay ekranina gecilir

### B. Kurulum

`/camera-setup` uzerinden:

- once sadece aktivasyon yapilabilir
- sonra tam kurulum yapilabilir

### C. Team'e manuel ekleme

`/team-device-add` uzerinden:

- short serial
- verification code
- alias
- area

bilgileriyle cihaz Team hesabina eklenebilir

### D. Cihaz detay yonetimi

`/device-detail` uzerinden:

- IP ayari
- reboot
- verification code
- cloud proxypass tabanli bazi cihaz konfigleri

yapilabilir

## 3. Cloud ve Yerel Katman Ayrimi

Bu projede en kritik mimari ayrim budur.

### Cloud tarafinda yapilanlar

- token alma
- kamera listesi alma
- stream URL alma
- jsDecoder / EZOPEN config hazirlama
- Team'e cihaz ekleme
- area ve kanal iliskileri
- proxypass ile aktif cihazlara bazi ISAPI istekleri

### Yerel ag tarafinda yapilanlar

- inactive cihaz tespiti
- ilk aktivasyon
- deviceInfo okuma
- network konfiguruasyonu
- Hik-Connect / EZVIZ enable etme

Net kural:

- inactive cihazin ilk aktivasyonu cloud API ile yapilmaz
- ilk aktivasyon, kameraya yerel agdan erisen bir SDK / native katman gerektirir

## 4. Aktivasyon Mantigi

Aktivasyon akisi iki farkli protokolden olusur:

### 4.1 Durum kontrolu

Kameranin aktif olup olmadigi su endpoint ile okunur:

```text
GET http://<kamera-ip>/ISAPI/System/activateStatus
```

Bu HTTP / ISAPI tarafidir.

### 4.2 Gercek aktivasyon

Gercek aktivasyon Hikvision HCNetSDK ile yapilir:

```text
NET_DVR_ActivateDevice(ip, 8000, activateCfg)
```

Burada:

- `ip` = kamera IP adresi
- `8000` = cihaz servis portu
- `activateCfg` = yeni admin parolasi

Yani:

- `activateStatus` = HTTP
- `aktivasyon komutu` = TCP tabanli SDK ozel protokolu

Bu yuzden yalniz browser ile aktivasyon yapilamaz. Kullanici deneyimi web icinde olabilir ama arkada backend veya native SDK katmani gerekir.

## 5. Bugunku Kurulum Akisi

Temel kurulum sayfasi:

```text
/camera-setup
```

Bu sayfada iki temel buton vardir:

### 5.1 Sadece Aktiflestir

Bu akis:

1. `activateStatus` okur
2. inactive ise SDK ile aktivasyon dener
3. aktivasyon sonrasi `deviceInfo` okur

Bu adim Team'e cihaz eklemez.

### 5.2 Kamera Ayarlarini Uygula

Bu akis:

1. gerekiyorsa aktivasyon yapar
2. deviceInfo okur
3. ag ayarlarini uygular
4. Hik-Connect / EZVIZ kaydini acar
5. Team hesabina cihazi ekler
6. kanal aktarimini tamamlar

Arka planda network ayarlarinda otomatik gonderilen DNS:

- `8.8.8.8`
- `1.1.1.1`

## 6. Cihaz Detay Akisi

`/device-detail` sayfasi Team tarafinda gorunen aktif cihazlara yoneliktir.

Bu sayfada:

- `GET /api/device-config/network`
- `PUT /api/device-config/network`
- `POST /api/device-config/reboot`
- `GET /api/device-config/ezviz`
- `PUT /api/device-config/ezviz`

endpointleri kullanilir.

Bu istekler cloud proxypass veya ilgili backend akisiyla cihaz tarafina tasinir.

Bu ekranin amaci:

- aktif cihazin ayrintili yonetimi
- cloud uzerinden proxypass kullanarak bazi cihaz ayarlarini yapmak

Ilk aktivasyon icin ana ekran degildir.

## 7. Izleme Akisi

Ana izleme sayfasi:

```text
/
```

Temel akisi:

1. backend saglik kontrolu
2. SDK config bilgisi
3. kamera listesi
4. secili kamera icin stream alma
5. HLS veya JSDecoder / EZOPEN ile oynatma

### HLS

HLS basit cihazlar icin uygun olabilir.

### EZOPEN / JSDecoder

Sifreli veya HLS ile acilmayan yayinlarda bu yol gerekir.

Bu sebeple projede:

- `sdk/`
- `jsdecoder-demo.html`

tarafi da vardir.

## 8. PTZ ve Proxypass

Projede PTZ ve bazi cihaz konfigleri Team cloud tarafindan alinan `resourceId` ile degil, bazen fiziksel `deviceId` ile yapilir.

Bu ayrim cok onemlidir:

- stream almak icin cogu zaman `resourceId`
- bazi proxypass ve cihaz seviyesindeki islemler icin `deviceId`

Ozellikle:

- PTZ
- network config
- verification code
- bazi ISAPI proxypass cagirilari

bu ayrima baglidir.

## 9. Backend Mimarisi

Ana backend:

- `server.js`

Node / Express uygulamasi burada kurulur.

Temel sorumluluklari:

- Team token almak
- cloud resource endpointlerine gitmek
- kamera listesi donmek
- stream URL olusturmak
- JSDecoder config vermek
- provisioning task baslatmak
- Team cihaz ekleme akislarini yonetmek
- proxypass cihaz config endpointlerini sunmak

## 10. Uzun Suren Gorevler

Kurulum gibi uzun isler task mantigiyla calisir.

Task mantigi:

- backend gorevi baslatir
- frontend sadece task id alir
- sonra task durumu polling ile okunur

Bu sayede aktivasyon ve kurulum gibi isler ekranda asama asama gorulebilir.

## 11. Temel Sayfalar

### `index.html`

Ana izleme arayuzu

### `provisioning.html`

Kurulum sayfasi

### `team-device-add.html`

Manuel Team ekleme ekrani

### `device-detail.html`

Cihaz detay ve proxypass tabanli konfig ekrani

### `browser-network-test.html`

Tarayici davranisi ve ag testi

### `jsdecoder-demo.html`

EZOPEN / JSDecoder demo sayfasi

## 12. Teknik Bilesenler

Projede kullanilan ana bilesenler:

- Node.js
- Express
- Hikvision Team OpenAPI
- Hikvision ISAPI
- Hikvision HCNetSDK
- hls.js
- JSDecoder / EZOPEN
- .NET tabanli yardimci projeler

## 13. Klasor Yapisi

### Kok seviyede onemli dosyalar

- `server.js`
- `index.html`
- `provisioning.html`
- `device-detail.html`
- `team-device-add.html`
- `browser-network-test.html`
- `jsdecoder-demo.html`
- `README.md`
- `PROJE_DETAYLI_DOKUMAN.md`
- `SDK_INCELEME_RAPORU.md`

### Destek klasorleri

- `sdk/`
  JSDecoder / web player dosyalari

- `src/HikDiscovery/`
  .NET yardimci projeleri

- `third_party/`
  HCNetSDK runtime dosyalari

- `artifacts/`
  build veya paket ciktilari

- `analysis/`, `_analysis/`
  arastirma ve inceleme notlari

## 14. Ortam Degiskenleri

Temel degiskenler:

- `HIK_APP_KEY`
- `HIK_APP_SECRET`
- `HIK_INITIAL_SERVER`
- `PORT`

## 15. Calistirma

```bash
npm install
npm start
```

Windows PowerShell:

```powershell
$env:HIK_APP_KEY="xxxx"
$env:HIK_APP_SECRET="xxxx"
npm start
```

Sayfalar:

```text
http://localhost:3000/
http://localhost:3000/camera-setup
http://localhost:3000/team-device-add
http://localhost:3000/device-detail
```

## 16. Bilinen Prensipler

Bu projede dogru anlamak gereken ana kurallar:

1. Ilk aktivasyon cloud tarafinda degil, yerel erisim tarafinda yapilir.
2. Team ekleme cloud tarafinda yapilir.
3. Aktif cihaz ayarlari cloud proxypass ile yapilabilir.
4. Sifreli yayinlar icin HLS her zaman yeterli degildir.
5. Bu nedenle JSDecoder / EZOPEN akisi projede kalici olarak onemlidir.
6. Aktivasyon sirasinda gorulen hata her zaman kamera hatasi degil, bazen SDK helper veya native runtime hatasidir.

## 17. Bu Dokumanin Amaci

Bu dokumanin amaci, projeyi tek bir cizgide anlatmaktir:

- ne cloud tarafinda yapiliyor
- ne yerelde yapiliyor
- hangi ekran ne ise yariyor
- aktivasyon ile normal cihaz yonetimi neden farkli

Detayli SDK seviyesi inceleme gerekiyorsa:

- `SDK_INCELEME_RAPORU.md`

dosyasi referans alinmalidir.

## 18. Kullanilan API, SDK ve Endpoint Listesi

Bu projede tek bir API yoktur. Isleme gore farkli katmanlar kullanilir.

### 18.1 Cloud / Team OpenAPI

Cloud tarafinda kullanilan ana yapi:

- HikCentral Connect Team OpenAPI

Temel endpoint gruplari:

- `POST /api/hccgw/platform/v1/token/get`
  Team access token almak icin

- `POST /api/hccgw/resource/v1/areas/cameras/get`
  Cloud kamera listesi almak icin

- `POST /api/hccgw/resource/v1/devices/get`
  Fiziksel cihaz bilgisi ve `deviceId` bulmak icin

- `POST /api/hccgw/platform/v1/streamtoken/get`
  JSDecoder / EZOPEN icin stream app token almak icin

- Team servis katmaninda kullanilan area / cihaz endpointleri
  area bulma, area olusturma, cihaz ekleme, device detail ve kanal import icin kullanilir

### 18.2 Cloud Proxypass

Aktif ve Team tarafinda gorunen cihazlarda bazi ISAPI isteklerini cloud uzerinden proxypass ile gonderiyoruz:

- `POST /api/hccgw/proxy/v1/isapi/proxypass`

Bu endpoint icine su JSON body gider:

```json
{
  "method": "GET|PUT|POST",
  "url": "/ISAPI/...",
  "id": "physicalDeviceId",
  "contentType": "application/xml",
  "body": "<xml>...</xml>"
}
```

Kritik kural:

- burada `id` olarak cogu durumda `resourceId` degil, fiziksel `deviceId` kullanilir

### 18.3 Kamera Uzerindeki Yerel ISAPI

Yerel agda cihaza dogrudan giden temel endpointler:

- `GET /ISAPI/System/activateStatus`
  aktif / inactive durumu icin

- `GET /ISAPI/System/deviceInfo`
  model, seri, MAC, firmware gibi kimlik bilgileri icin

- `GET /ISAPI/System/Network/interfaces`
  network config okumak icin

- `PUT /ISAPI/System/Network/interfaces/{id}`
  IP, subnet, gateway, DNS guncellemek icin

- `PUT /ISAPI/System/reboot`
  cihaz reboot icin

- `GET /ISAPI/System/Network/EZVIZ`
  Hik-Connect / EZVIZ durumunu okumak icin

- `PUT /ISAPI/System/Network/EZVIZ`
  Hik-Connect / EZVIZ ve verification code guncellemek icin

- `GET /ISAPI/PTZCtrl/channels/1/capabilities`
  PTZ capability okumak icin

- `PUT /ISAPI/PTZCtrl/channels/1/continuous`
  pan / tilt / zoom komutu icin

### 18.4 HCNetSDK

Ilk aktivasyon ve bazi yerel kesif / cihaz servis portu islemlerinde:

- Hikvision `HCNetSDK`

kullanilir.

Bu tarafta kritik fonksiyonlar:

- `NET_DVR_Init`
- `NET_DVR_SetSDKInitCfg`
- `NET_DVR_ActivateDevice`
- `NET_DVR_Login_V40`
- `NET_DVR_GetSadpInfoList`

Aktivasyonun kendisi HTTP ile degil, SDK tarafinda cihaz servis portu uzerinden gider.

## 19. Islem Bazinda Hangi Bilgi Gerekir

Her islem icin gereken veri ayni degildir.

### 19.1 Kamera listeleme

Gerekenler:

- `HIK_APP_KEY`
- `HIK_APP_SECRET`

Donen temel alanlar:

- `name`
- `resourceId`
- `deviceSerial`
- `cameraIndexCode`
- `channelNo`

### 19.2 Cloud izleme

Gerekenler:

- `resourceId`
- `deviceSerial`
- opsiyonel `quality`
- opsiyonel `protocol`

JSDecoder / EZOPEN akisinda ek olarak:

- stream token endpointinden gelen `appToken`
- `appKey`
- `streamAreaDomain`

### 19.3 Sadece aktivasyon

Gerekenler:

- `cameraIp`
- `userName` genelde `admin`
- yeni `password`
- `sdkPort` genelde `8000`

Bu asamada `areaName`, `verificationCode`, `resourceId` veya `deviceId` gerekmez.

### 19.4 Kamera ayarlarini uygula

Gerekenler:

- `cameraIp`
- `userName`
- `password`
- opsiyonel `areaName`
- opsiyonel `gatewayOverride`
- opsiyonel `enableDhcp`
- `sdkPort`

Arka planda otomatik kullanilanlar:

- `dns1 = 8.8.8.8`
- `dns2 = 1.1.1.1`
- verification code bos ise sistem tarafinda uretilir

### 19.5 Hik-Connect / EZVIZ ayari

Gerekenler:

- aktif cihaza erisim
- `deviceId` veya yerel modda kamera IP
- `verificationCode`

Bu islem lokal ISAPI veya cloud proxypass ile yapilabilir. Inactive cihazda once aktivasyon gerekir.

### 19.6 Team hesabina cihaz ekleme

Gerekenler:

- `shortSerial`
- `verificationCode`
- opsiyonel `alias`
- `areaName` veya `areaId`

Burada kamera admin parolasi bazen backend workflow icinde halen gerekir, cunku kanal import veya cihaz detail adimlari ile bagli akislar olabilir.

### 19.7 PTZ

Iki farkli seviye vardir:

1. Cloud video seviyesinde kontrol
2. Cihaz seviyesinde ISAPI PTZ

Proxypass tabanli PTZ icin gerekenler:

- `deviceId`
- `channelNo`
- `pan`
- `tilt`
- `zoom`

## 20. Projedeki Onemli Backend Endpointleri

Frontend'in bizim backend'imize cagridigi ana endpointler:

### Izleme

- `GET /api/health`
- `GET /api/sdk-config`
- `GET /api/cameras`
- `GET /api/stream`

### Kurulum

- `POST /api/provision/activate`
- `POST /api/provision/start`
- `GET /api/provision/tasks/:taskId`

### Team'e ekleme

- `POST /api/team-devices/add`

### Cihaz detay

- `GET /api/device-config/network`
- `PUT /api/device-config/network`
- `POST /api/device-config/reboot`
- `GET /api/device-config/ezviz`
- `PUT /api/device-config/ezviz`

### PTZ

- `POST /api/ptz/continuous`

## 21. Frontend Sayfa Bazinda Hangi Isler Yapilir

### `/`

Bu sayfa:

- backend health kontrol eder
- cloud kamera listesini alir
- stream baslatir
- secili kamera icin `device-detail` ekranina gecis verir

### `/camera-setup`

Bu sayfa:

- yerel aktivasyon baslatir
- tam kurulum task'i baslatir
- task durumlarini gosterir
- isterse yerel agent ekranini acar

### `/team-device-add`

Bu sayfa:

- sadece Team ekleme formudur

### `/device-detail`

Bu sayfa:

- secili aktif cihazin detay ayarlarini cloud proxypass ile gunceller

## 22. Hangi Islemde Hangi Kimlik Kullanilir

Bu kisim karismaya cok acik oldugu icin acikca ayiriyoruz.

### `cameraIp`

Yerel cihazla dogrudan konusurken kullanilir.

### `resourceId`

Cloud kamera kaydini temsil eder.
Izleme tarafinda cok kullanilir.

### `deviceId`

Fiziksel cihazi temsil eder.
Ozellikle proxypass ve bazi cihaz seviyesi cloud islemlerinde gerekir.

### `deviceSerial`

Cloud stream ve cihaz esleme akislarinda kullanilir.

### `shortSerial`

Team'e cihaz ekleme akisinda onemlidir.
Genelde seri numaranin kisa formudur ve Team backend bu bilgiyle cihaz kaydini bulur / ekler.

### `verificationCode`

Hik-Connect / EZVIZ ile Team'e cihaz ekleme arasindaki baglayici degerdir.

## 23. Mobil Uygulama Tarafi Icin Sonuc

Eger kendi mobil uygulamanizda ayni agda aktivasyon yapmak isterseniz:

- cloud API tek basina yetmez
- yerel agda cihaza erisen bir SDK katmani gerekir
- bunun icin dogru SDK `HCNetSDK` tarafidir

Yani:

- cloud izleme icin OpenAPI + JSDecoder mantigi
- ilk aktivasyon icin HCNetSDK mantigi

ayni anda dusunulmelidir.
