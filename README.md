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

## Notlar

- Bu proje su an bir baslangic iskeleti. Kullanici yonetimi, yetkilendirme, rate limiting ve stream proxy gibi production ihtiyaclari henuz ekli degil.
- Bazi Hikvision ortamlari HLS yerine farkli protokoller donebilir. O durumda `/api/stream` parametreleri veya player tarafi uyarlanmalidir.
- Uzun sureli kullanim icin stream linkinin suresi dolmadan once otomatik yenilenmesi gerekir.
