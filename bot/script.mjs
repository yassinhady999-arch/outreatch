// What the bot says after the greeting, one message per real reply from the clinic. After
// the last one, a reply means a person takes over: the clinic gets «متابعة» (or «غير مهتم»
// if they say no).
// Edit the texts freely. {name} is the clinic's name and {city} its city. A part in
// [square brackets] is left out when a placeholder inside it is empty (e.g. no city).
// Emoji, periods, commas and colons are removed before sending (cleanText in core.mjs),
// also from clinic names like «عيادة د. وائل».

export const SCRIPT = [
  // 1 — after they answer the salam: may I have the management's or the manager's number?
  [
    "الله يحييك عندك مانع تعطيني رقم الإدارة أو المدير؟",
    "عندي اقتراح عن إعلانات تيك توك وسناب لابتسامة هوليود[ في {city}] أريد رقم التواصل معه عشان أعرضها عليه",
  ].join(String.fromCharCode(10)), // two lines
];

// Once, when nobody answered the greeting for 24 hours (sent in the evening)
export const FOLLOW_UP = "مساء الخير بس أتأكد إن رسالتي وصلت";
