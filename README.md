# KAMERA

Hikvision cloud uzerinden kamera listesini alip secilen kameranin canli yayin adresini alan basit bir Node.js baslangic projesi.

Bu surum su akisi kurar:

1. `HIK_APP_KEY` ve `HIK_APP_SECRET` ile token alir.
2. Kamera listesini `/api/cameras` uzerinden doner.
3. Secilen kamera icin `/api/stream` uzerinden HLS oynatma linki alir.
4. `index.html` bu linki `hls.js` ile tarayicida oynatir.

22 Temmuz 2026 itibariyla projede ayri bir web sayfasi daha vardir:

5. `/camera-setup` uzerinden kamera aktivasyon ve provisioning akisi calistirilir.
6. Linux ortaminda resmi `HCNetSDK` paketiyle native helper kullanilarak `NET_DVR_ActivateDevice` cagrilir.
7. ISAPI ile `deviceInfo`, ag ayarlari ve `EZVIZ` durumu yonetilir.
8. `registerStatus=true` olduktan sonra Team OpenAPI ile cihaz eklenir ve kamera kanallari area'ya otomatik aktarilir.

23 Temmuz 2026 itibariyla projede Team OpenAPI'yi ayri bir web akisi olarak kullanan ek ekran da vardir:

9. `/team-device-add` ekraninda kullanici `shortSerial`, `verificationCode`, `alias` ve `areaName` bilgilerini girer.
10. Frontend sadece bizim backend endpoint'imizi cagirir: `POST /api/team-devices/add`
11. Backend Team token alma, cihaz ekleme, area bulma/olusturma, `devicedetail/get` ve `areas/resources/add` adimlarini kendi tarafinda yurutur.
12. Hikvision token, AK, SK, admin parola ve verification code frontend'e veya loglara yazilmaz.

24 Temmuz 2026 oncesi yerel kurulum yardimcisi olarak Windows x64 icin indirilebilir bir agent paketi de hazirlandi:

13. `/LocalAgent` sayfasi tarayicidan `http://127.0.0.1:47831` uzerindeki yerel agent ile konusur.
14. Agent, kamerayla ayni yerel agdaki Windows bilgisayarda calisir; kamera aktivasyon ve ISAPI provisioning islerini yerelde yapar.
15. Team OpenAPI AK/SK ve token akisi backend'de kalir; yerel agent sadece bizim backend endpoint'imizi cagirir.
16. Paketleme script'i: `scripts/Publish-LocalAgent.ps1`
17. Uretilen zip yolu: `src/HikDiscovery/HikProvisioning.Web/wwwroot/downloads/local-agent/HikProvisioning.Agent-win-x64.zip`

## JSDecoder SDK notu

Bu projede cloud akisinin Hikvision tarafinda sifreli gelmesi nedeniyle nihai hedef `WASM / JSDecoder SDK` entegrasyonudur.

Su an proje:

- token alma
- kamera listeleme
- stream endpoint deneme
- SDK config hazirlama

adimlarini yapar.

Tam entegrasyon icin TPP'den indirdiginiz `WASM (JSDecoder) Develop Kit` dosyalarini proje altinda su klasore koymaniz gerekir:

```text
/sdk
```

Beklenen tipik dosyalar:

- `*.js`
- `*.wasm`
- `*.worker.js`

Bu dosyalar geldikten sonra frontend tarafi Hikvision'in resmi player akisina gecirilecektir.

## Gereken ortam degiskenleri

| Degisken | Aciklama |
|---|---|
| `HIK_APP_KEY` | Hikvision / HikCentral Connect AppKey |
| `HIK_APP_SECRET` | Hikvision / HikCentral Connect AppSecret |
| `HIK_INITIAL_SERVER` | Ilk token sunucusu. Varsayilan: `https://ieu.hikcentralconnect.com` |
| `PORT` | Opsiyonel. Varsayilan: `3000` |

Ornek `.env` icin:

```text
.env.example
```

## Linux provisioning notu

Eger projeyi Linux sunucuda ve kamera ile ayni yerel agda calistiracaksaniz:

- resmi Linux SDK paketi workspace altinda su dizinde olmalidir:

```text
/third_party/hcnetsdk_linux64/EN-HCNetSDKV6.1.9.48_build20230410_linux64
```

- native helper'i derleyin:

```bash
npm run build:linux-helper
```

Bu komut su binary'yi uretir:

```text
/native/hik_activation_helper_linux/build/hik_activation_helper
```

Sunucuda ayrica sunlar gerekli:

- `g++` / `make`
- `Node.js 18+`
- kameraya HTTP (`80`) ve SDK (`8000`) erisimi
- backend ile kameranin ayni yerel agda olmasi

## Yerelde calistirma

```bash
npm install
HIK_APP_KEY=xxxx HIK_APP_SECRET=xxxx npm start
```

Windows PowerShell icin:

```powershell
$env:HIK_APP_KEY="xxxx"
$env:HIK_APP_SECRET="xxxx"
npm start
```

Sonra tarayicida:

```text
http://localhost:3000
```

Provisioning sayfasi:

```text
http://localhost:3000/camera-setup
```

Team cihaz ekleme sayfasi:

```text
http://localhost:3000/team-device-add
```

Yerel agent sayfasi:

```text
http://localhost:3000/LocalAgent
```

Yerel agent paketini uretmek icin:

```powershell
powershell -ExecutionPolicy Bypass -File scripts/Publish-LocalAgent.ps1
```

Agent paketini calistirmak icin:

```text
artifacts/local-agent/bundle/HikProvisioning.Agent-win-x64/start-agent.cmd
```

## API'ler

### `GET /api/health`

Sunucunun token alip alamadigini ve area domain bilgisini dondurur.

### `GET /api/cameras`

Kamera listesini dondurur.

Ornek cevap:

```json
{
  "cameras": [
    {
      "name": "On Giris",
      "online": true,
      "resourceId": "xxx",
      "cameraIndexCode": "xxx",
      "deviceSerial": "FB....",
      "channelNo": "1"
    }
  ]
}
```

### `GET /api/stream`

Zorunlu query parametreleri:

- `resourceId`
- `deviceSerial`

Opsiyonel query parametreleri:

- `quality=1` -> HD
- `quality=2` -> Akici
- `protocol=2` -> HLS

Ornek:

```text
/api/stream?resourceId=xxx&deviceSerial=yyy&quality=1
```

### `POST /api/team-devices/add`

Kamerayi Team hesabina ekler, area'yi bulur/olusturur ve eksik kamera kanallarini ilgili area'ya aktarir.

Istek:

```json
{
  "shortSerial": "ABCD123456",
  "verificationCode": "VERIFY123456",
  "alias": "CAM-ABCD123456",
  "areaName": "Musteri - Sube 1"
}
```

Ornek cevap:

```json
{
  "message": "Cihaz Team hesabina eklendi ve kanal import akisi tamamlandi.",
  "result": {
    "success": true,
    "shortSerial": "ABCD123456",
    "alias": "CAM-ABCD123456",
    "areaId": "1001",
    "areaName": "Musteri - Sube 1",
    "deviceId": "device-123",
    "deviceAdded": true,
    "importedChannelCount": 0,
    "totalChannelCount": 1,
    "deviceStatusMessage": "Cihaz eklendi.",
    "channelStatusMessage": "Cihaz importToArea enable=1 ile eklendi; portalda manuel import gerekmiyor."
  }
}
```

Bu akista frontend Hikvision'a dogrudan istek gondermez.

## Testler

Gercek Hikvision API'sine cikmadan mock ile test etmek icin:

```bash
npm test
```

Test kapsaminda:

- token alma ve yenileme
- area yoksa olusturma
- mevcut cihazda sadece eksik kanallari import etme
- Hikvision hata kodunu guvenli mesajla yuzeye cikarabilme

## Notlar

- Bu proje su an bir baslangic iskeleti. Kullanici yonetimi, yetkilendirme ve rate limiting gibi production ihtiyaclari henuz ekli degil.
- Bazi Hikvision ortamlari HLS yerine farkli protokoller donebilir. O durumda `/api/stream` parametreleri veya player tarafi uyarlanmalidir.
- Uzun sureli kullanim icin stream linkinin suresi dolmadan once otomatik yenilenmesi gerekir.
- Workspace icinde Postman collection dosyasi bulunmadi. Bu nedenle backend entegrasyonu, repoda zaten kullanilan Team OpenAPI endpoint'leri ve `Hik-Connect for Teams OpenAPI Developer Guide_V2.15.0_20260306.pdf` dosyasinin repo referansina gore duzenlendi.
