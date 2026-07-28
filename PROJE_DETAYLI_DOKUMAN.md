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
