# Kamera Projesi

Bu proje, Hikvision / HikCentral Connect Team OpenAPI ile cloud kamera izleme, yerel ağdaki cihazları kurma ve cihazları Team hesabına ekleme akışlarını tek bir Node.js uygulamasında toplar.

## Projenin Bugünkü Kapsamı

Proje şu işleri yapar:

1. Hikvision Team OpenAPI ile token alır.
2. Cloud kamera listesini çeker.
3. Kamerayı HLS veya JSDecoder / EZOPEN akışı ile izletir.
4. Yerel ağdaki kamerayı aktive eder.
5. Kamera ağ ayarlarını uygular.
6. Kamera üzerinde Hik-Connect / EZVIZ kaydını açar.
7. Kamerayı Team hesabına ekler.
8. Kamera kanallarını ilgili area altına bağlar.
9. Cihaz detay ekranından cloud proxypass ile IP, reboot, verification code ve bazı cihaz ayarlarını yönetir.

## Temel Sayfalar

- `/`
  Cloud kamera listesi ve izleme ekranı

- `/camera-setup`
  Kurulum ekranı
  Önce `Sadece Aktiflestir`, sonra `Kamera Ayarlarini Uygula` akışı burada çalışır

- `/team-device-add`
  Sadece Team hesabına cihaz ekleme ekranı

- `/device-detail`
  Seçili cihaz için network, reboot, verification code ve cloud proxypass tabanlı cihaz detay ekranı

- `/camera-browser-test`
  Tarayıcı / ağ davranışı testi

- `/jsdecoder-demo.html`
  EZOPEN / JSDecoder demo sayfası

## Cloud ve Yerel İşlerin Ayrımı

Projede iki farklı dünya vardır:

### 1. Cloud tarafı

Cloud tarafında şu işlemler yapılır:

- Team token alma
- Kamera listesi çekme
- Stream alma
- PTZ için cloud veya proxypass tabanlı çağrılar
- Team hesabına cihaz ekleme
- Area / channel ilişkilendirme

### 2. Yerel cihaz tarafı

Yerel cihaz tarafında şu işlemler yapılır:

- `activateStatus` okuma
- inactive cihazı aktive etme
- IP / gateway / DNS / DHCP ayarlama
- Hik-Connect / EZVIZ enable etme

Kritik kural:

- Cloud tarafı inactive cihazı ilk kez aktive etmez.
- İlk aktivasyon yerel ağdan, kameraya doğrudan erişen bir katmanla yapılır.
- Bizim web tool bunu backend üzerinden başlatır.

## Aktivasyon Nasıl Çalışır

Aktivasyon iki parçalıdır:

1. Durum kontrolü HTTP / ISAPI ile yapılır:

```text
GET http://<kamera-ip>/ISAPI/System/activateStatus
```

2. Gerçek aktivasyon Hikvision SDK üzerinden yapılır:

```text
NET_DVR_ActivateDevice(ip, 8000, activateCfg)
```

Yani:

- `activateStatus` = HTTP
- `aktivasyon komutu` = SDK özel protokolü / cihaz servis portu

Bu yüzden aynı ağda olsanız bile ilk aktivasyon için yalnız browser yeterli değildir; backend veya native SDK katmanı gerekir.

## Kurulum Sayfası Akışı

`/camera-setup` ekranında iki temel buton vardır:

### `Sadece Aktiflestir`

Bu akış:

1. kameranın `activateStatus` bilgisini okur
2. cihaz inactive ise SDK ile aktivasyon dener
3. aktivasyon sonrası `deviceInfo` okur

Bu aşamada Team’e cihaz ekleme yapılmaz.

### `Kamera Ayarlarini Uygula`

Bu akış:

1. gerekirse aktivasyon yapar
2. ağ ayarlarını uygular
3. DNS’i arka planda sabit yollar
4. Hik-Connect / EZVIZ ayarını açar
5. Team hesabına cihaz ekler
6. kanal aktarımını tamamlar

Şu an arka planda sabit gönderilen DNS:

- `8.8.8.8`
- `1.1.1.1`

## Cihaz Detay Sayfası

`/device-detail` ekranı seçili cihaz üzerinde cloud proxypass ile şu işleri yapar:

- network oku
- IP ayarını kaydet
- cihazı reboot et
- verification code oku
- verification code kaydet
- aynı sayfadan provisioning task başlat

Bu ekran inactive cihaz aktivasyonu için değil, aktif ve Team tarafında görünür cihaza yönelik yönetim ekranıdır.

## Team’e Ekleme Akışı

Team’e ekleme iki şekilde yapılabilir:

1. Kurulum akışının sonunda otomatik
2. `/team-device-add` ekranından manuel

Backend bu akışta şunları yapar:

- area bulur veya oluşturur
- cihazı ekler
- cihaz zaten varsa tekrar eklemeye çalışmaz
- eksik kamera kanallarını ilgili area’ya bağlar

## PTZ ve Cihaz Konfigürasyonu

Projede iki farklı kontrol seviyesi vardır:

- Cloud video kontrolü
- Proxypass ile cihaz ISAPI çağrıları

Özellikle bazı cihaz fonksiyonları için `resourceId` değil `physical deviceId` gerekir.

## Ortam Değişkenleri

Gerekli değişkenler:

- `HIK_APP_KEY`
- `HIK_APP_SECRET`
- `HIK_INITIAL_SERVER`
- `PORT`

Örnek:

```powershell
$env:HIK_APP_KEY="xxxx"
$env:HIK_APP_SECRET="xxxx"
npm start
```

## Çalıştırma

```bash
npm install
npm start
```

Varsayılan adres:

```text
http://localhost:3000
```

Önemli ekranlar:

```text
http://localhost:3000/
http://localhost:3000/camera-setup
http://localhost:3000/team-device-add
http://localhost:3000/device-detail
```

## Önemli Notlar

- İlk aktivasyon cloud üzerinden değil, yerel ağ erişimiyle yapılır.
- Kamera ayarları ve verification code değişimi hem yerelden hem de uygun durumlarda cloud proxypass ile yapılabilir.
- Şifreli yayınlarda HLS her zaman yeterli değildir; bu nedenle projede JSDecoder / EZOPEN akışı da vardır.
- Aktivasyon tarafında sorun yaşanırsa problem çoğu zaman kameradan değil, SDK helper / native runtime tarafından çıkar.

## Dosya Haritası

- `server.js`
  Ana backend

- `index.html`
  İzleme ekranı

- `provisioning.html`
  Kurulum ekranı

- `device-detail.html`
  Cihaz detay ekranı

- `team-device-add.html`
  Team’e cihaz ekleme ekranı

- `PROJE_DETAYLI_DOKUMAN.md`
  Daha ayrıntılı mimari doküman

- `SDK_INCELEME_RAPORU.md`
  HCNetSDK odaklı teknik inceleme notları
