# KAMERA

Hikvision cloud uzerinden kamera listesini alip secilen kameranin canli yayin adresini alan basit bir Node.js baslangic projesi.

Bu surum su akisi kurar:

1. `HIK_APP_KEY` ve `HIK_APP_SECRET` ile token alir.
2. Kamera listesini `/api/cameras` uzerinden doner.
3. Secilen kamera icin `/api/stream` uzerinden HLS oynatma linki alir.
4. `index.html` bu linki `hls.js` ile tarayicida oynatir.

## Gereken ortam degiskenleri

| Degisken | Aciklama |
|---|---|
| `HIK_APP_KEY` | Hikvision / HikCentral Connect AppKey |
| `HIK_APP_SECRET` | Hikvision / HikCentral Connect AppSecret |
| `HIK_INITIAL_SERVER` | Ilk token sunucusu. Varsayilan: `https://ieu.hikcentralconnect.com` |
| `PORT` | Opsiyonel. Varsayilan: `3000` |

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
