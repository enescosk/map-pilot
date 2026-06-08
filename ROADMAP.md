# MapPilot — Yol Haritası

Bu dosya demo sonrası planı tutar. Her madde bittiğinde commit message'da
`closes ROADMAP#1` gibi referans verilebilir.

---

## 📍 Şu Anki Durum (2026-06-08, commit 690bf56)

### Çalışan
- ✅ Cockpit sayfası: hız, GPS, steering, brake, throttle, EPS, battery, heading
- ✅ Kamera akışı (zed2i compressed, JSON path)
- ✅ Rosbridge canlı bağlantı (172.22.78.35:9090)
- ✅ Telemetri throttle (33ms batch)
- ✅ Hız doğru hesaplanıyor (`VelocityMS × 0.01 × 3.6`)
- ✅ CAN sıfır frame'leri filtreleniyor (vehicle.js + topicMap.js + derivedTelemetry.js)
- ✅ Web Worker JSON parse + lidar filter off main thread
- ✅ Binary point-cloud protocol (server tarafında çalışıyor)
- ✅ In-place GPU buffer Three.js (43 MB/s GC churn → 0)
- ✅ Decision Log kompakt
- ✅ 275/275 test geçiyor

### Çalışmayan / Şüpheli
- ❓ LiDAR frontend render — backend frame yolluyor, browser çizmiyor.
  Son fix (`690bf56`) alignment padding ekledi, **demo öncesi 5 dk denenecek**.
- ⚠️ Rosbridge'den gelen camera-frame `_type` yok diye dropplanabilir bazı
  topic'lerde (compressed image OK çünkü topic name eşleşiyor).

---

## 🎯 Önümüzdeki Hafta — Öncelik Sırası

### P0 — LiDAR Render Bug Avı (yarım gün)

**Hipotez sırası**:

1. **Worker error**: Browser F12 console'da `worker-error` mesajı var mı?
   - `frameWorker.ts:166` artık try/catch ile hata fırlatıyor
   - Varsa hata mesajından kaynağa git
2. **cloud-ready ulaşıyor mu**: App.tsx:1492 `handleWorkerMessage` çağrılıyor mu?
   - `console.log` ekle, geçici olarak
3. **setPointClouds güncelleniyor mu**: `pointClouds` state'i debug etmek için
   React DevTools ile bak
4. **Three.js render**: `displayPoints.length > 0` ama nokta görünmüyorsa,
   `pointToDisplayThree` koordinat dönüşümünde z=0'a sıkışıyor olabilir
5. **Frame ID problemi**: `activeTopic` doğru topic'e kilitleniyor mu?

**Test bag**: `2025-07-21-16-54-43.bag` — bu bag'de zed2i + rslidar var.

### P1 — Performans (1-2 gün, dikkatli)

`2c72901` baseline'a döndük. O zaman kaybolan iyileştirmeleri **küçük PR'lar
halinde** geri getir:

1. **Uint8Array support** (`server/normalizers/image.js`)
   - rosbag library `Uint8Array` döner, kontrol etmiyoruz → bag'den image gelmiyor
   - 10 satır fix, izole test edilebilir
2. **Rosbridge type inference** (`server/sources/vehicleRosSource.js`)
   - rosbridge v0.11+ `_type` göndermiyor → topic name'den türet
   - `inferRosTypeFromTopic()` helper, izole test edilebilir
3. **Idempotent socket** (`server/sources/vehicleRosSource.js`)
   - Çift connect-source'da "closed before established" hatası
   - State guard + `if (socket !== rosSocket) return` pattern
4. **CameraViewer subscribe-after-mount** (`src/App.tsx`)
   - `isBinary` dependency'ye eklenmeli, canvas mount'tan sonra subscribe
5. **Camera binary protocol** (server + worker + viewer)
   - Base64 data URL yerine raw JPEG bytes
   - Worker'da `createImageBitmap` off main thread
   - Canvas'a transferable bitmap

### P2 — Mimari (1 hafta)

1. **Zustand migration**
   - App.tsx 19 useState → tek dashboardStore
   - Panel'ler `useDashboardStore(s => s.x)` ile topic-bazlı subscribe olur
   - **Beklenen**: panel re-render'ları 5-10× azalır
   - Stub zaten var: `src/store/dashboardStore.ts` (revert'te silindi, geri ekle)
2. **App.tsx parçalama**
   - 1687 satır → 200 satır hedef
   - `Lidar3D`, `LidarWorkspace`, `Lidar2D` ayrı dosyaya
   - `VehicleCockpit`, `SpeedGauge` zaten `components/` altında ama
     App.tsx kendi inline tanımlarını kullanıyor — duplicate'ler silinmeli
3. **Playwright perf baseline**
   - `e2e/perf.spec.ts` regression detector
   - p95 long task < 50ms hedefi

### P3 — Demo Sonrası Polish

- **Snapshot-on-reconnect**: Reconnect'te tüm telemetry store snapshot'ı,
  şu an son envelope gönderiyor — bazı alanlar boş kalıyor
- **Bag playback kaldır** (kullanıcı isteği): canlı odaklı sistem
  - `useBagPlayback`, `BagDetailsPanel`, `bagPlaybackSource.js`
  - UI'daki bag picker dropdown
  - App.tsx'teki bag state'leri (~30 değişiklik)
- **Server-side bag queue heap**: `Array.sort` her mesajda → O(N log N), heap'e çevir
- **TF tree visualization** (Foxglove'un yaptığı gibi)
- **Multi-source/multi-bag synchronized playback** (uzun vadeli)

---

## 📚 Öğrendiklerimiz (Hata Tarihçesi)

### Hız Bug'ları
1. `VelocityKMH × 0.1` yanlış scale — `VelocityMS × 0.01 × 3.6` doğru
2. CAN bus boş frame'lerde `VelocityMS=0` gönderiyor — her saniye 50 frame'de
   sadece 1 tanesi gerçek değer. Sıfır filtrelendi.
3. Odom `twist.linear=0` paketleri de sıfır speed yazıyordu — derivedTelemetry'de
   `speedMps > 0` kontrolü eklendi.

### Binary Protocol Bug'ları
1. `Float32Array(buf, offset)` 4-byte aligned offset gerektiriyor — header pad
   eklenmedi → tüm point cloud'lar sessizce drop edildi.
2. `compressedImageToSource` `Uint8Array` desteklemiyordu — rosbag'den image
   geliyordu ama empty string dönüyordu.
3. `rosbridge_server v0.11+` `_type` field'ı göndermiyor — normalizer dispatch
   `lowerType.includes(...)` ile çalıştığı için her mesaj droppanıyordu.
4. Çift `connect-source` (UI double-click veya StrictMode) — eski socket
   CONNECTING durumdayken yeni socket açılıyor → "closed before established"
   hatası UI'da görünüyordu.
5. `CameraViewer` subscribe useEffect canvas mount'tan önce çalışıyordu →
   bitmap'ler canvas'a hiç boyanmıyordu.

### React Bug'ları
1. App.tsx 19 useState root'ta → tüm panel'ler her güncellemede reconcile
   (yaklaşık 5000 component diff invocation / saniye yoğun yükte)
2. `setLatestFrame` 6 farklı yerden 100+ Hz çağrılıyordu → throttle eklendi
3. `JSON.stringify(packet.telemetry).slice(0, 220)` her telemetry frame'de
   main thread'de çalışıyordu — preview field için
4. Lidar3D'de Three.js geometry her frame'de yaratılıp dispose ediliyordu →
   ~43 MB/s GC churn

### CSS Bug'ları
1. `text-overflow: ellipsis` `.panel-titlebar span` → "Vehicle Cockpit"
   "Vehicle Cock..." şeklinde kesiliyordu (utanç verici)
2. Sabit `font-size: 1.08rem` + `overflow: hidden` ebeveyn → GPS koordinatları
   görünmez kesiliyordu. `clamp()` + ellipsis fallback çözdü.
3. `cockpit-status-grid` `grid-template-columns: repeat(4, 1fr)` → dar panelde
   kart'lar kırpılıyordu. `auto-fit minmax(130px, 1fr)` çözdü.

---

## 🚨 Yapma Notları (kendime)

- **Demo'dan günler önce büyük refactor yapma** — küçük PR'lar, her birini
  kullanıcı doğrular
- **Browser console hatalarını mutlaka iste** — backend log'ları yetmez
- **Domain-spesifik bug'lar için gerçek veriyi incele** — `node` ile direkt
  rosbag açıp gerçek değerleri gör, varsayım yapma
- **`git revert` > `git reset --hard`** — push'lanmış commit'leri silmek
  yerine ters çevir, history bozulmaz
- **Test ve TypeScript her commit'te yeşil kalsın** — 275/275 disiplini
- **`Foxglove gibi yapalım` cazip ama tehlikeli** — onlar 200 dev-yıl
  yatırım yapmış, biz fokuslu bir dashboard yapıyoruz

---

## 📎 Faydalı Komutlar

```bash
# Backend başlat
node server/index.js

# Dev server
npm run dev

# Test
npx vitest run

# Type check
npx tsc --noEmit

# Production build
npx vite build

# Backend'in ne gönderdiğini gör (vehicle-ros bağlantısı)
node --input-type=module << 'EOF'
import WebSocket from 'ws';
const ws = new WebSocket('ws://localhost:4000');
const types = new Map();
ws.on('open', () => {
  ws.send(JSON.stringify({ type: 'connect-source', source: 'vehicle-ros',
    rosbridgeUrl: 'ws://172.22.78.35:9090' }));
  setTimeout(() => {
    for (const [t,c] of [...types.entries()].sort((a,b)=>b[1]-a[1])) console.log(`${c}x  ${t}`);
    process.exit(0);
  }, 8000);
});
ws.on('message', (data) => {
  if (data[0] === 0x7b) {
    const msg = JSON.parse(data.toString());
    types.set('JSON:'+msg.type, (types.get('JSON:'+msg.type)||0)+1);
  } else {
    const headerLen = data.readUInt32LE(0);
    const header = JSON.parse(data.subarray(4, 4 + headerLen).toString('utf8'));
    types.set('BIN:'+header.type, (types.get('BIN:'+header.type)||0)+1);
  }
});
EOF

# Bag dosyasındaki topic'leri listele
node --input-type=module << 'EOF'
import Bag from 'rosbag';
const bag = await Bag.open('/path/to/file.bag');
for (const [, conn] of Object.entries(bag.connections)) {
  console.log(`${conn.topic}  [${conn.type}]`);
}
EOF
```

---

## 🔌 Sabit Adresler

- Dashboard bilgisayarı: `172.22.78.39`
- Araç bilgisayarı: `172.22.78.35`
- Rosbridge: `ws://172.22.78.35:9090`
- Bag dizini: `~/Desktop/enes_ws/bag/`
- Frontend: `http://localhost:5173`
- Backend WS: `ws://localhost:4000`
