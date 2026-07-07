# MapPilot — Çalışma Kuralları

## ROADMAP güncel tutma (ZORUNLU)
Anlamlı her değişiklikten sonra `ROADMAP.md` güncellenmeli. "Anlamlı" =
bir özellik/fix/refactor tamamlandığında, bir madde bittiğinde, ya da
sistemin durumu (test sayısı, çalışan/çalışmayan liste, öncelikler) değiştiğinde.

- Biten maddeyi ilgili öncelikten çıkar, gerekiyorsa "Çalışan" veya
  "Öğrendiklerimiz" bölümüne taşı.
- "Şu Anki Durum" başlığındaki tarih + commit'i güncelle.
- Test sayısı değiştiyse sağlık göstergelerini güncelle.
- ROADMAP değişikliğini o iş ile aynı commit'e ya da hemen ardından commit'le.

Bu kural memory'de de kayıtlı ([[roadmap-keep-updated]]).

## Kalite kapıları (her commit yeşil kalsın)
- `npx vitest run` — şu an 346 test
- `npx tsc --noEmit` — temiz
- `npx vite build` — çalışır

## Çalıştırma
- Canlı araç: `npm run live-ros` (DERIVE_VEHICLE=true şart — yoksa gauge boş kalır)
- Frontend: `npm run dev` → http://localhost:5173
- Backend: `npm run server` → ws://localhost:4000
