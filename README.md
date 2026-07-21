# KAMERA

Hikvision cloud uzerinden kamera listesini alip secilen kameranin canli yayin adresini alan ve bu adresi tarayiciya uygun bir oynatma akisina baglamaya hazirlanan Node.js projesi.

## Bugunku durum

Bu proje su adimlari calisir:

1. `HIK_APP_KEY` ve `HIK_APP_SECRET` ile token alir.
2. Kamera listesini `/api/cameras` uzerinden doner.
3. Secilen kamera icin `/api/stream` uzerinden canli yayin adresi alir.
4. Hik-Connect sifreli cihazlarda calisan sonuc genellikle `ezopen://...` olur.

Onemli nokta:

- `ezopen://` adresi standart bir `m3u8` olmadigi icin `hls.js` ile dogrudan oynatilamaz.
- `Render` gibi Linux ortamlarda bu akisi tek basina Node.js ile tarayiciya uygun hale getirmek mumkun degildir.
- Bunun icin ya `WASM (JSDecoder) Develop Kit` gerekir ya da `Windows uzerinde calisan native bir bridge servis` gerekir.

## Yeni hedef mimari

Bu repo artik su mimariye gore hazirlaniyor:

1. Node.js backend Hik-Connect OpenAPI uzerinden `ezopen://` adresini alir.
2. Bu adres bir `Windows bridge servisine` gonderilir.
3. Bridge servis `HCVideoSDK` kullanarak akisi acar.
4. Bridge servis bunu tarayiciya uygun bir formata cevirir.
   - ideal olarak `HLS`
   - alternatif olarak `MJPEG` veya baska browser-friendly cikis
5. `index.html` artik dogrudan Hikvision SDK yerine bridge cikisini oynatir.

## Neden Render tek basina yetmiyor

Elimizdeki `HCVideoSDK-V3.1.0` ve `HPNetSDK` paketleri `Windows native DLL` tabanlidir.

Bu nedenle:

- `Render` uzerinde bu native SDK'lari calistiramayiz
- sadece `Node.js + hls.js` ile `ezopen://` acamayiz
- donusturme servisi Windows ortaminda ayri bir servis olarak calismalidir

## SDK notu

`WASM / JSDecoder` kitini Hikvision hesabi icin actirabilirseniz, browser tarafi icin ayri bir bridge gerekmeden dogrudan resmi tarayici oynaticisina gecilebilir.

Bu repo yine de bridge senaryosunu destekleyecek sekilde ilerletilmektedir, cunku su an hesapta WASM kit erisimi yok gibi gorunmektedir.

## Gereken ortam degiskenleri

| Degisken | Aciklama |
|---|---|
| `HIK_APP_KEY` | Hikvision / HikCentral Connect AppKey |
| `HIK_APP_SECRET` | Hikvision / HikCentral Connect AppSecret |
| `HIK_INITIAL_SERVER` | Ilk token sunucusu. Varsayilan: `https://ieu.hikcentralconnect.com` |
| `HIK_BRIDGE_BASE_URL` | Opsiyonel. Windows bridge servis adresi. Ornek: `http://127.0.0.1:8787` |
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
- `protocol=1` -> EZOPEN
- `protocol=2` -> HLS
- `target=bridge` -> URL alindiktan sonra bridge servise yonlendir
- `code=xxxxxx` -> cihaz verification code

Ornek:

```text
/api/stream?resourceId=xxx&deviceSerial=yyy&quality=1&code=Admin123
```

## Notlar

- Bu proje halen gelisim asamasindadir. Kullanici yonetimi, yetkilendirme, rate limiting ve production seviyesi stream yonetimi henuz eksiktir.
- Hik-Connect tarafi sifreli cihazlarda `EZOPEN` dondugu icin standart web player kutuphaneleri dogrudan yeterli olmaz.
- Elimizdeki `HCVideoSDK` sunucu tarafinda akis callback'leri verebildigi icin bridge servisi icin teknik temel vardir.
- Uzun sureli kullanim icin stream linkinin suresi dolmadan once otomatik yenilenmesi gerekir.
- Bridge servis ayaga kalkmadan bu repo tek basina browser-playable HLS uretemez.
