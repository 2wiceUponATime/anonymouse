import { env } from "cloudflare:workers"
import { FF1 } from "ff1-js"

const alphabet = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const prefix = "anon_";

const cipher = new FF1(
    env.ID_TRANSFORM_SECRET,
    "",
    alphabet.length,
    alphabet,
);

export function toAnonymous(id: string) {
    return prefix + cipher.encrypt(id.slice(1).toUpperCase());
}

export function fromAnonymous(id: string) {
    return "U" + cipher.decrypt(id.slice(prefix.length).toUpperCase());
}