# MapPilot — Yol Haritası

Bu dosya demo sonrası planı tutar. Her madde bittiğinde commit message'da
`closes ROADMAP#1` gibi referans verilebilir.

---

## 📍 Şu Anki Durum (2026-07-08, commit c3bf06f)

**Sağlık göstergeleri:** 349/349 test geçiyor · `tsc --noEmit` temiz · `vite build` çalışıyor.

### Çalışan
- ✅ **Cockpit sayfası** — hız gauge, GPS (lat/lon/alt), heading, steering, brake,
  throttle, EPS, battery, sürüş modu
- ✅ **Türetilmiş telemetri** — kokpit metrikleri hareket sensörlerinden türetiliyor
  (`DERIVE_VEHICLE=true` gerektirir; bkz. `npm run live-ros`)
- ✅ **Hız** — GPS konumundan hesaplanıyor (odometry `twist=0` donma bug'ı çözüldü)
- ✅ **Dönüş sinyali** — heading değişim hızından türetiliyor (steering açısından değil)
- ✅ **Kamera akışı** — zed2i compressed, canlı
- ✅ **Harita** — OpenStreetMap, canlı GPS pin'i
- ✅ **LiDAR 3D render** — nokta bulutu tarayıcıda çiziliyor; pipeline sadece LiDAR
  sayfasında aktif (gate'li), doğrudan Float32 decode, in-place GPU buffer
- ✅ **LiDAR worker hızlandırıldı (2026-07-08)** — `frameWorker.ts`'te gelen
  RSLidar frame'i (parse-binary) ve 32.000 noktalık history artık hiç JS
  objesine çevrilmeden, doğrudan `Float32Array` üzerinde filtrelenip
  voxel-downsample ediliyor (obje sadece son, ≤60.000 noktalık render setine
  materialize ediliyor). Sentetik benchmark (130k nokta/frame × 50 frame):
  9.80 ms/frame → 2.32 ms/frame (**~4.2x**). Wire format değişmedi, tek dosya
  (`src/workers/frameWorker.ts`), 349 test + tsc + build yeşil.
- ✅ **Vehicle Control paneli** — steering / cruise / brake / mode, ARM + deadman
- ✅ **E-STOP** — sekizgen dur-tabelası butonu, SPACE kısayolu, disarm'da nötr komut
- ✅ **Rosbridge canlı bağlantı** + otomatik yeniden bağlanma (backoff reset)
- ✅ **Reconnect snapshot** — bağlantı kurulunca kümülatif telemetri snapshot'ı
  gönderiliyor (`server/index.js`), kartlar boş kalmıyor
- ✅ **MQTT köprüsü** — dashboard ↔ araç arası alternatif taşıma (rosbridge yoksa)
- ✅ **Control safety** — komutlar topic başına rate-limit'li
- ✅ **Topic sağlık servisi** — per-topic lastSeen / fresh-stale takibi (backend)
- ✅ **Decision Log** — kompakt, boş-durum destekli
- ✅ **Tek komut demo** — `npm run demo` / `npm run demo:down` (scripts/)
- ✅ **CI** — GitHub Actions her push/PR'da: `npm ci` → tsc → test → build
- ✅ **Topic keşfi (Faz 1)** — `/rosapi/topics` ile araç yayınladığı tüm topic'ler
  keşfediliyor (gerçek araçta 211 topic), UI'da listeleniyor; liste önbelleğe
  alınıp geç bağlanan dashboard'a da gönderiliyor.
- ✅ **Topic seçimi + ham veri (Faz 2)** — listeden topic seçince dinamik abone
  ol (`subscribe-topic`), ham mesaj JSON olarak "Ham Mesajlar" panelinde. Her mesaj
  tipinde çalışır. Fixed base/lidar aboneliklerine dokunmaz. Sessiz topic'lerde
  (ör. /clock, /tf) 3 sn sonra "N sn'dir veri yok" uyarısı gösterilir.

### Kaldırılanlar (bilinçli sadeleştirme)
- ❌ Bag playback (`bagPlaybackSource.js`) — canlı odaklı sisteme geçildi;
  normalizer'lar bağımsızlaştırılıp korundu
- ❌ LiDAR birikimli harita (Map) görünümü
- ❌ Start/Stop LiDAR + Start/Stop Mapping butonları
- ❌ Sunum deck'i ve ekran görüntüleri (repo dışına)

### Geçici / Borç
- ⚠️ **Sahte batarya değeri** — `deriveVehicleTelemetry.js` içinde placeholder;
  gerçek batarya topic'i gelince kaldırılacak (`feat: temporary fake battery`)
- ⚠️ **Kamera gerçek hızı ~3.5 Hz (2026-07-08 ölçüldü)** — 27 GB demo bag'inde
  `/zed2i/zed_node/rgb/image_rect_color/compressed` `rostopic hz` ile ölçülünce
  ortalama **3.5 Hz** çıktı (`min 0.276s max 0.317s` frame aralığı) — bu bag
  kaydının kendi karakteristiği, dashboard/JS tarafında bir throttle/bug yok.
  Ayrıca UI'daki "FPS" etiketi (`CameraPanel.tsx`) yanıltıcı: ROS mesajında
  `fps` diye bir alan yok (`sensor_msgs/CompressedImage`'te böyle bir alan
  bulunmuyor), `normalizers/index.js:150`deki `Number(message.fps || 0)`
  hep 0 döner; `LiveCameraViewer.tsx`/`CameraViewer.tsx`'teki "N frames"
  ise fps değil, bağlantı başından beri gelen toplam kare sayacı — hız
  yorumlamak için kullanılmamalı. Gerçek araçtaki canlı ZED2i'nin gerçek Hz'i
  ayrı doğrulanmalı (bu bag'in düşük hızı donanımdan mı kayıt pipeline'ından
  mı geldiği netleşmedi).

---

## 🎯 Öncelik Sırası

### Aktif — Topic seçimi & layout

- [x] **Layout: kamera letterbox** — `.camera-stage` `aspect-ratio: 16/9` +
  `object-fit: cover`; üst/alt siyah bantlar gitti.
- [x] **Layout: topic paneli** — sol sütundan sağ sütuna taşındı; cockpit alt
  şeridinde IMU+Speed (üst üste) yanında tam yükseklik topic listesi (211 topic).
- [x] **Topic seçimi + ham veri (Faz 2)** — kullanıcı listeden topic'e tıklayınca
  backend `subscribe-topic` ile dinamik abone oluyor; gelen mesaj "Ham Mesajlar"
  panelinde JSON olarak gösteriliyor. Gerçek araçla doğrulandı (/imu/data).
- [x] **Topic paneli: arama/filtre** — topic adı/tipine göre arama kutusu;
  başlıkta "N/toplam" sayacı, temizle butonu, eşleşme yoksa boş-durum.
- [ ] **Akıllı görselleştirme** — seçilen topic tipine göre görsel: sayı→grafik,
  görüntü→resim, konum→harita. Ham JSON "detay" olur. (Asıl yıldız özellik; büyük iş.)
- [ ] **Kontrol paneli ayrı sayfa** — Vehicle Control (steering/cruise/brake/mode)
  ayrı "Kontrol" sekmesine. E-STOP her sayfada sabit kalır (güvenlik).


### ✅ P0 — CI Kurulumu (BİTTİ, 2026-07-07)

`.github/workflows/ci.yml` — her push/PR'da `npm ci` → `tsc --noEmit` →
`vitest run` → `vite build`, Node 22. Üç kapı da yerelde yeşil doğrulandı.
Kalan (opsiyonel): README'ye yeşil badge, Node sürüm matrix'i.

### P1 — Kayıt & Replay (2-3 gün)  ← SIRADAKİ

Canlı oturumu diske yazıp sonradan oynatma. Altyapı hazır: her envelope zaten
`telemetryBus` üzerinden tek noktadan akıyor.

1. **Recorder** — `telemetryBus` ENVELOPE aboneliği, `.ndjson` olarak diske yaz
   (timestamp + envelope). Env flag ile aç/kapa (`RECORD=true`).
2. **replaySource.js** — `directLidarSource` / `mqttBridgeSource` deseninde yeni
   source; `.ndjson`'u zaman damgalarına göre oynatır (gerçek zamanlı veya hızlı).
3. **UI** — kayıt dosyası seç + oynat/duraklat/hız kontrolü (bağlantı panelinde mod).
4. **Test** — recorder round-trip (yaz → oku → byte-identical), replay zamanlaması.

### P2 — E2E Smoke Testleri (1-2 gün, CI'dan sonra)

Playwright dependency olarak var ama config/test yok.

- [ ] `playwright.config.ts` + `e2e/` klasörü
- [ ] Smoke: sayfa açılıyor, Cockpit ↔ LiDAR geçişi çalışıyor
- [ ] Synthetic source ile: gauge veri gösteriyor, kartlar dolu
- [ ] E-STOP butonu görünür ve tıklanabilir
- [ ] CI'a `e2e` job'ı olarak ekle (backend + frontend ayağa kaldırıp koş)

### P3 — Güvenilirlik Sertleştirme (dağınık, canlı araçta kritik)

1. **Stale-data watchdog (UI)** — backend'de `topicHealthService` var ama UI'da
   her karta bağlı değil. Bir topic X sn susarsa kartı gri/uyarı durumuna al;
   gauge son değeri "canlı" gibi göstermesin.
2. **E-STOP onay döngüsü** — şu an "komut gönderildi" diyor; `autonomous_report` /
   brake response'tan aracın gerçekten durduğunu doğrula. "gönderildi ≠ uygulandı".
3. **Sahte batarya kaldır** — gerçek topic geldiğinde placeholder'ı temizle.

### P4 — Performans / State (ölçümden sonra, dikkatli)

⚠️ **Önce ölç, sonra dokun.** App.tsx artık 431 satır (temiz), acil bir sorun
yok. Sadece profiler gerçek bir darboğaz gösterirse:

1. **Store migration** — App.tsx 18 hook → merkezi store (Zustand veya
   context+reducer). Paneller topic-bazlı subscribe olur, re-render azalır.
   Ölçüm olmadan spekülatif; React DevTools Profiler ile baseline al.
2. **Playwright perf baseline** — p95 long task < 50ms regresyon dedektörü.
3. **LiDAR worker→main postMessage transferable'a geçsin** — `frameWorker.ts`
   `cloud-ready` mesajı hâlâ `Point3D[]` gönderiyor (structured clone);
   ölçülen maliyet 60k noktada ~33 ms/frame (bkz. Öğrendiklerimiz #6).
   `Float32Array` + transfer list'e geçilirse ~0 ms'e iner — ama wire format
   değişir, App.tsx / usePointCloudBuffer.ts / Lidar3D.tsx da güncellenmeli
   (4 dosya, daha geniş blast radius; #1'den ayrı, dikkatli PR).

### P5 — Uzun Vadeli (fikir havuzu)

- TF tree görselleştirme
- Çoklu kamera / çoklu LiDAR yerleşimi
- Olay/alarm şeridi (E-STOP, bağlantı kopması, mod değişimi — zaman damgalı log)
- Mod-farkındalıklı UI kilidi (yanlış modda komut göndermeyi önle)

---

## 📚 Öğrendiklerimiz (Hata Tarihçesi)

### Hız Bug'ları
1. `VelocityKMH × 0.1` yanlış scale — `VelocityMS × 0.01 × 3.6` doğru
2. CAN bus boş frame'lerde `VelocityMS=0` gönderiyor — 50 frame'de 1'i gerçek.
   Sıfırlar filtrelendi.
3. Odom `twist.linear=0` paketleri de sıfır hız yazıyordu — `speedMps > 0` kontrolü.
4. Odometry fallback'te hız donuyordu → hız GPS **konumundan** hesaplanıyor artık.

### Binary Protocol Bug'ları
1. `Float32Array(buf, offset)` 4-byte aligned offset ister — header pad eklenmezse
   tüm nokta bulutları sessizce drop olur.
2. `rosbridge_server v0.11+` `_type` göndermiyor — normalizer dispatch topic
   adından tür türetmeli.
3. Çift `connect-source` (StrictMode / double-click) — "closed before established";
   state guard ile çözüldü.

### React / Perf Bug'ları
1. Root'ta çok sayıda useState → her güncellemede tüm paneller reconcile.
   Paneller `memo`'landı (VehicleCockpit / MapPanel / CameraViewer / LidarWorkspace).
2. Three.js geometry her frame'de yaratılıp dispose ediliyordu → ~43 MB/s GC churn;
   in-place GPU buffer'a geçildi.
3. Nokta bulutu ara obje dizisi üzerinden decode ediliyordu → doğrudan Float32.
4. Arka planda sınırsız büyüyen telemetri buffer'ı donmaya yol açıyordu → sınırlandı.
5. LiDAR pipeline her sayfada çalışıyordu → sadece LiDAR sayfasına gate'lendi.
6. `frameWorker.ts` her gelen frame'de 32.000 noktalık history'yi baştan JS
   objesine çeviriyordu (readTopicBuffer) + Map<number,Point3D> ile
   downsample yapıyordu → circular buffer üzerinde index-tabanlı çalışacak
   şekilde yeniden yazıldı, obje sadece final render seti için üretiliyor
   (~4.2x, ölçüldü). Ayrıca fark edildi ama henüz düzeltilmedi: worker →
   main thread `postMessage`'daki `Point3D[]` structured-clone maliyeti
   60k noktada ~33 ms/frame — transferable `Float32Array`'e geçilirse
   ~0 ms'e iner (bkz. P4).

---

## 🚨 Yapma Notları (kendime)

- **Demo'dan günler önce büyük refactor yapma** — küçük PR'lar, her birini doğrula
- **Perf işine ölçmeden girme** — profiler baseline olmadan "hızlandırma" spekülatif
- **Browser console hatalarını mutlaka iste** — backend log'ları yetmez
- **Domain bug'ları için gerçek veriyi incele** — varsayım yapma, `node` ile aç bak
- **`git revert` > `git reset --hard`** — push'lanmışı ters çevir, history bozma
- **Test ve TypeScript her commit'te yeşil kalsın** — 346/346 disiplini
- **`Foxglove gibi yapalım` cazip ama tehlikeli** — fokuslu bir dashboard yapıyoruz

---

## 📎 Faydalı Komutlar

```bash
# Canlı araç (türetilmiş telemetri açık)
npm run live-ros          # LIDAR_SOURCE=vehicle-ros DERIVE_VEHICLE=true

# Tek komut demo
npm run demo              # ayağa kaldır
npm run demo:down         # kapat

# Ayrı ayrı
npm run server            # backend  → ws://localhost:4000
npm run dev               # frontend → http://localhost:5173

# Diğer modlar
npm run dashboard-mqtt    # MQTT köprüsü (rosbridge yoksa)
npm run vehicle-live      # araç tarafı, MQTT publish açık

# Kalite kapıları
npx vitest run            # 346 test
npx tsc --noEmit          # tip kontrolü
npx vite build            # production build
```

---

## 🔌 Sabit Adresler

- Dashboard bilgisayarı: `172.22.78.39`
- Araç bilgisayarı: `172.22.78.35`
- Rosbridge: `ws://172.22.78.35:9090`
- Frontend: `http://localhost:5173`
- Backend WS: `ws://localhost:4000`
