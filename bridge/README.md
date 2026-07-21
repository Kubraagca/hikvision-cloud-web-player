# Windows Bridge Servisi

Bu klasor, Hik-Connect tarafindan alinan `ezopen://` adresini tarayiciya uygun bir yayina ceviren yardimci servis icin ayrilmistir.

## Neden gerekli

`/api/stream` endpoint'i su anda calisan bir `EZOPEN` adresi alabiliyor:

- ornek: `ezopen://******@open.ezviz.com/FB2262228/1.hd.live`

Ancak:

- tarayici `ezopen://` protokolunu dogrudan acamaz
- `hls.js` sadece `m3u8` oynatir
- `Render` uzerindeki Node.js servisi tek basina `HCVideoSDK` native DLL'lerini calistiramaz

Bu nedenle Windows uzerinde calisan ayri bir bridge servis gereklidir.

## Beklenen gorev

Bridge servis su isi yapmalidir:

1. Node backend'den `sourceUrl` olarak `ezopen://...` alir.
2. `HCVideoSDK` ile bu URL'ye baglanir.
3. Akin stream callback veya decode callback uzerinden veriyi alir.
4. Tarayiciya uygun bir cikisa cevirir:
   - tercih edilen: `HLS`
   - alternatif: `MJPEG`
5. Oynatilabilir bir URL dondurur.

## Onerilen endpoint sozlesmesi

### `POST /api/ingest/start`

Ornek istek:

```json
{
  "streamId": "fb2262228-1-hd",
  "sourceUrl": "ezopen://******@open.ezviz.com/FB2262228/1.hd.live",
  "cameraName": "HIKVISION",
  "quality": 1
}
```

Ornek cevap:

```json
{
  "ok": true,
  "streamId": "fb2262228-1-hd",
  "playbackUrl": "http://127.0.0.1:8787/live/fb2262228-1-hd/index.m3u8",
  "protocol": "hls"
}
```

### `GET /health`

Ornek cevap:

```json
{
  "ok": true,
  "runtime": "windows",
  "sdkLoaded": true
}
```

## Teknik not

`HCVideoSDK-V3.1.0` icinde `Video_StartPreview` ve `fnStream` / `fnDecodedStream` callback'leri bulunuyor. Bu, teorik olarak `ezopen://` kaynagini native SDK ile acip browser tarafina uygun baska bir cikisa cevirmenin mumkun oldugunu gosterir.

Ama bu bridge:

- `Render` icinde degil
- `Windows makine` veya `Windows VPS` icinde
- native DLL'lerle

calismalidir.
