// Public access: Telegram supplies identity; no registration or operator allowlist.
// Groups, bot accounts and invalid identities are outside the private-chat flow.
export function privateUserContext(update){
  const message=update?.message||update?.callback_query?.message;
  const user=update?.message?.from||update?.callback_query?.from;
  if(message?.chat?.type!=='private'||!user||user.is_bot||
     !Number.isSafeInteger(user.id)||user.id<=0||message.chat.id!==user.id)return null;
  return {message,user};
}
