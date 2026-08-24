# Railway deploy

1. Bu klasörün içeriğini bir GitHub reposunun köküne yükleyin. `Dockerfile` repo kökünde görünmeli.
2. Railway > New Project > Deploy from GitHub repo ile repoyu seçin.
3. Service > Variables altında:
   - APP_PASSWORD=<güçlü parola>
   - DATA_DIR=/data
   - REQUEST_DELAY_MS=1400
   - REQUEST_TIMEOUT_MS=20000
   - CRON_SCHEDULE=10 3 * * *
4. Service > Settings > Volumes > Add Volume; mount path `/data`.
5. Service > Settings > Networking > Generate Domain.
6. Domain açıldığında Basic Auth ekranında kullanıcı adı olarak herhangi bir değer, parola olarak APP_PASSWORD kullanın.
