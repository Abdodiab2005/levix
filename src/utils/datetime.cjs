// Timezone helpers.
//
// المستخدم بيكتب "22:30 07-06-2025" وهو قاصد توقيت البوت (BOT_TIMEZONE)، مش
// توقيت السيرفر. `new Date(y, m, d, h, mi)` بيبني بتوقيت السيرفر المحلي، فعلى
// سيرفر UTC الرسالة كانت بتتجدول بفارق ساعتين/تلاتة عن اللي المستخدم طلبه.

const settings = require("../config/settings.cjs");

// A getter, not a constant: the timezone is changeable from the dashboard.
const defaultTimezone = () => settings.get("bot_timezone");

// الفرق بين المنطقة الزمنية دي و UTC عند اللحظة دي بالتحديد (بيتغير مع
// التوقيت الصيفي، فلازم يتحسب على تاريخ معيّن مش مرة واحدة).
function zoneOffsetMs(date, timeZone = defaultTimezone()) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  })
    .formatToParts(date)
    .reduce((acc, part) => {
      acc[part.type] = part.value;
      return acc;
    }, {});

  const wallClock = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour),
    Number(parts.minute),
    Number(parts.second)
  );

  // بنشيل الملي ثانية من الطرفين عشان الفرق يطلع نظيف.
  return wallClock - Math.floor(date.getTime() / 1000) * 1000;
}

// ساعة حائط في منطقة زمنية -> لحظة حقيقية (Date بـ UTC جوّاها).
function zonedTimeToDate(
  { year, month, day, hour = 0, minute = 0, second = 0 },
  timeZone = defaultTimezone()
) {
  const asUtc = Date.UTC(year, month - 1, day, hour, minute, second);
  if (!Number.isFinite(asUtc)) return new Date(NaN);

  // تخمين ثم تصحيح: التكرار التاني بيمسك الحالات اللي الفرق فيها بيتغير
  // بين التخمين والنتيجة (حوالين تحويل التوقيت الصيفي).
  let timestamp = asUtc;
  for (let i = 0; i < 2; i++) {
    timestamp = asUtc - zoneOffsetMs(new Date(timestamp), timeZone);
  }
  return new Date(timestamp);
}

module.exports = { defaultTimezone, zoneOffsetMs, zonedTimeToDate };
