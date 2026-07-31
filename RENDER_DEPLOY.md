# Render Deploy

Bu proje Render'da en saglikli sekilde `Docker` runtime ile deploy edilmelidir.

Sebep:
- Ana uygulama `Node.js`
- Plaka tanima servisi `Python`
- Node uygulamasi calisirken `alpr-service/app.py` dosyasini child process olarak baslatir

Normal `Node` runtime yerine `Docker` secilmelidir. Cunku ALPR icin Python da ayni deploy icinde hazir olmalidir.

## Repo icindeki gerekli dosyalar

- `Dockerfile`
- `render.yaml`
- `alpr-service/`
- `alpr-service/models/`

## Render Dashboard uzerinden kurulum

1. Render'da `New +` -> `Web Service` sec.
2. GitHub repo'yu bagla.
3. Runtime olarak `Docker` sec.
4. `Dockerfile Path` alanini `./Dockerfile` olarak birak.
5. Branch olarak deploy etmek istedigin branch'i sec.
6. Gerekli environment variable'lari `Environment` ekranindan ekle.
7. Deploy et.

## Start command gerekiyor mu?

Hayir.

Bu proje Docker ile deploy edildigi icin Render, `Dockerfile` icindeki `CMD` komutunu calistirir:

`node server.js`

Yani Render panelinde ayrica `Start Command` yazman gerekmez.

## Environment variables

Mevcut Hikvision tool canlida hangi env'lerle calisiyorsa onlar aynen eklenmelidir.

Ornek olarak:
- Hikvision / EZVIZ access bilgileri
- app key / secret
- projede zaten kullanilan diger backend degiskenleri

ALPR icin repo icinde su varsayim kullanilir:

- `ALPR_PYTHON=python3`

Bu deger `render.yaml` icinde tanimlidir. Gerekirse panelden de override edilebilir.

## Gerekli notlar

- Uygulama Render'in verdigi `PORT` degiskeni ile calisir.
- ALPR servisi disariya ayrica port acmaz; Node icinden local olarak baslatilir.
- Model dosyalari repo ile birlikte deploy edilmelidir.
- Push tek basina yeterli olmazsa sebep genelde servis tipinin `Node` kalmis olmasidir. Bu proje `Docker Web Service` olarak deploy edilmelidir.

## Deploy sonrasi kontrol

Canli servis ayaga kalktiktan sonra su endpoint ile ALPR durumunu test edebilirsin:

`/api/alpr/health?autostart=1`

Basarili durumda servis Python ALPR process'ini otomatik baslatir.

## Beklenen sonuc

Bu endpoint basarili cevap donuyorsa:
- Node uygulamasi ayaga kalkmistir
- Python ALPR servisi baslatilabilmistir
- Plaka tanima ekrani canlida da calisabilecek durumdadir
