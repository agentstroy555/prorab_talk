// Embedded by explicit instruction of the project owner.
export const DEFAULT_BOT_TOKEN = "8581068700:AAGomN-xthjKuIKG5Wl1p1gcwVKItRMvm7E";
export function botToken(env=process.env){return env.TELEGRAM_BOT_TOKEN?.trim()||DEFAULT_BOT_TOKEN;}
