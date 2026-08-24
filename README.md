# KDV Radar — Trendyol Ürün Avcısı

%1 KDV whitelist kategorilerindeki Trendyol ürünlerini keşfeder, her gün ürün sayfasından fiyat ve değerlendirme toplamını kaydeder; 1/7/15/30 günlük değerlendirme artışlarını hesaplar.

## Özellikler

- Web dashboard
- Düzenlenebilir %1 KDV kategori whitelist'i
- Kategori bazlı baz komisyon alanı
- Trendyol kategori sayfalarında ürün keşfi
- Günlük değerlendirme toplamı ve fiyat snapshot'ı
- 1G / 7G / 15G / 30G değerlendirme farkları
- Arama, kategori, fiyat ve değerlendirme-hızı filtreleri
- Her gün 03:10 Europe/Istanbul otomatik tarama
- SQLite kalıcı veri
- Basic Auth ile parola koruması
- Docker ile internete deploy edilebilir

## Önemli tasarım notları

1. **Talep ölçümü:** Yazılı yorum yerine `Değerlendirme` toplamını ana sinyal olarak kullanır. Yıldız verip metin yazmayan müşterileri de kapsadığı için daha geniş örneklemdir.
2. **Geçmiş veri:** Trendyol geçmiş 7/15/30 gün değerini vermediğinden bot kendi günlük snapshot'larını biriktirir. İlk gün yalnızca bugünkü toplam görünür; 7 gün sonra 7G, 30 gün sonra 30G farkı oluşur.
3. **Fiyat:** Ürün sayfasındaki ana/buybox fiyatı veya yapılandırılmış verideki en düşük teklif fiyatı okunur. Sayfa yapısı değişirse `src/scraper.js` selector'ları güncellenebilir.
4. **Komisyon:** Whitelist'teki `base_commission` referans/baz orandır. Satıcıya, markaya, alt kategoriye ve kampanyaya göre gerçek oran değişebilir. Panelden düzenlenebilir.
5. **KDV:** Whitelist manuel kontrollüdür. Özel tıbbi amaçlı gıda gibi farklı oranlı istisnaları aynı kategoriye karıştırmayın.
6. **Tarama etiği:** Uygulama captcha/erişim engeli aşmaya çalışmaz. HTTP 429 alırsa taramayı durdurur. `REQUEST_DELAY_MS` ile istek hızını muhafazakâr tutun.

## Yerelde çalıştırma

Docker kuruluysa:

```bash
docker compose up -d --build
```

Tarayıcı: `http://localhost:3000`

Varsayılan docker-compose parolası `degistir-beni`. İnternete açmadan önce değiştirin.

## İnternete yükleme

### Railway / Render / VPS

Bu proje Dockerfile içerir. Docker destekleyen bir hostta GitHub reposunu bağlayıp deploy edebilirsiniz.

Gerekli ortam değişkenleri:

- `APP_PASSWORD`: panel parolası
- `DATA_DIR=/data`
- `REQUEST_DELAY_MS=1400` (gerekirse 2000–3000'e çıkarın)
- `CRON_SCHEDULE=10 3 * * *`

**Kalıcı disk/volume bağlayın ve mount path'i `/data` yapın.** Aksi halde SQLite geçmişi deploy/restart sırasında kaybolabilir.

### Kendi VPS'inizde

```bash
git clone <repo>
cd trendyol-kdv-bot
cp .env.example .env
# docker-compose.yml içindeki parolayı değiştirin
docker compose up -d --build
```

Alan adını Cloudflare/Nginx/Caddy ile sunucuya yönlendirebilirsiniz. HTTPS kullanın.

## İlk kullanım

1. `Kategoriler` ekranını açın.
2. İstediğiniz whitelist kategorilerini etkin bırakın.
3. Baz komisyonları kendi Trendyol Satıcı Panelinizdeki oranlarla düzeltin.
4. `Şimdi Tara` butonuna basın.
5. İlk tarama kategori sayfalarından ürünleri keşfeder, ardından ürünleri tek tek tarar.
6. Bot her gün snapshot biriktirdikçe 1/7/15/30 günlük kolonlar dolmaya başlar.

## Whitelist başlangıç kategorileri

Başlangıçta şu kategoriler örnek olarak etkin gelir: Takviye Edici Gıda & Vitamin, Türk Kahvesi, Kahve, Kuru Gıda, Zeytinyağı, Sıvı Yağ.

Bebek maması gibi grupları, özel tıbbi amaçlı ürünlerle karışma riskini azaltmak için varsayılan whitelist'e eklemedim; doğruladığınız kategori URL'sini panelden ekleyebilirsiniz.

## Sonraki sürüm için mantıklı ekler

- Toptan alış fiyatı girme
- %15/%17,29 vb. komisyon + 93 TL kargo + KDV ile net kâr hesaplama
- Satıcı sayısını daha güvenilir ayrı veri kaynağından alma
- E-posta/Telegram fırsat bildirimi
- CSV/Excel dışa aktarma
- Trendyol Satıcı Paneli komisyon CSV'sini içe aktarma
- Ürün birleştirme/anomali uyarısı (ör. bir günde +10.000 değerlendirme)

