# V6 — Yerel Chrome Ajanı

Railway/Amsterdam üzerinden Trendyol 403 verdiği için tarama artık Railway sunucusunda yapılmaz.
Dashboard ve SQLite veritabanı Railway'de kalır; Trendyol sayfalarını kullanıcının normal Chrome'u üzerinden Chrome uzantısı tarar ve sonuçları siteye yollar.

1. Bu V6 patch'i GitHub reposuna yükleyin ve Railway'in deploy olmasını bekleyin.
2. `kdv-radar-chrome-agent.zip` dosyasını çıkarın.
3. Chrome > `chrome://extensions` > Geliştirici modu > Paketlenmemiş öğe yükle > çıkarılan klasörü seçin.
4. Uzantı ikonuna tıklayın. Sunucu adresi varsayılan olarak mevcut Railway domainidir.
5. Ajan anahtarına Railway'deki `APP_PASSWORD` değerini yazın ve Kaydet'e basın.
6. Dashboard'u yenileyin. Tarama kartında `Ajan bağlı` yazmalıdır.
7. Dashboard'da `Şimdi Tara` butonuna basın. Uzantı Trendyol kategorilerini arka planda sekmeler açarak tarar.

Not: Uzantı CAPTCHA veya erişim engeli aşmaya çalışmaz. Trendyol normal tarayıcıda sayfayı göstermiyorsa tarama durur ve hata raporlanır.
