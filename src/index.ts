import { type AnyRichTextSectionElement, type RichTextSection, SlackApp } from "slack-cloudflare-workers";
import { AnyBlock, ChatPostMessageResponse, MrkdwnElement, PlainTextElement, retryPolicies, WebClient } from "@slack/web-api"
import { env } from "cloudflare:workers";
import emojiMap from "../emoji/emoji-map.json";
import { fromAnonymous, toAnonymous } from "./id-transform";

const client = new WebClient(env.SLACK_BOT_TOKEN);

function text(text: string): PlainTextElement {
    return {
        type: "plain_text",
        text,
    };
}

function mrkdwn(text: string): MrkdwnElement {
    return {
        type: "mrkdwn",
        text,
    };
}

function stringifyRichTextSection(section: RichTextSection | AnyRichTextSectionElement) {
    switch (section.type) {
        case "text":
            return section.text
        case "emoji":
            return (emojiMap as Record<string, string>)[section.name] ?? `:${section.name}:`;
        default:
            return "[]"
    }
}

async function canHavePerms(user: string) {
    const permsGroup = await client.usergroups.users.list({
        usergroup: env.PERMS_GROUP
    });
    return permsGroup.users!.includes(user);
}

function hasPerms(user: string) {
    return user == env.CREATOR
}

export default {
    async fetch(
        request: Request,
        env: Env,
        ctx: ExecutionContext
    ): Promise<Response> {
        const auth = await client.auth.test();

        const app = new SlackApp({ env })
            .anyMessage(async ({ payload: message }) => {
                if (message.subtype) return;
                if (!message.thread_ts) return;
                const thread = (await client.conversations.history({
                    channel: message.channel,
                    latest: message.thread_ts,
                    inclusive: true,
                    limit: 1,
                })).messages![0];
                if (thread.user != auth.user_id) return;
                const text = thread.text!.split(";")[0];
                console.log(text);
                const alt = message.blocks!
                    .filter(block => block.type == "rich_text")
                    .map(block => block.elements
                        .map(element => element.elements
                            .map(stringifyRichTextSection)
                            .join("")
                        )
                        .join("")
                    )
                    .join("")
                if (text.startsWith("Replies")) {
                    const replaced = text.replace(/^Replies to ([a-zA-Z0-9\./]+) will appear here$/, "$1");
                    if (text == replaced) return;
                    const [channel, ts] = replaced.split("/");
                    
                    await client.chat.postMessage({
                        channel,
                        thread_ts: ts,
                        blocks: message.blocks!,
                        text: alt,
                    });
                } else if (text.startsWith("From")) {
                    const replaced = text.replace(/^From: (anon_[a-zA-Z0-9]+) \(reply to ([0-9\.]+)\)$/, "$1/$2");
                    if (text == replaced) return;
                    const [anon, ts] = replaced.split("/");
                    const user = fromAnonymous(anon);
                    const channel = await client.conversations.open({
                        users: user,
                    });
                    await client.chat.postMessage({
                        channel: channel.channel!.id!,
                        blocks: message.blocks,
                        text: alt,
                        thread_ts: ts,
                    })
                }
            })
            .event("app_home_opened", async ({ payload }) => {
                const extraBlocks: AnyBlock[] = [];
                if (hasPerms(payload.user)) {
                    extraBlocks.push({
                        type: "actions",
                        elements: [
                            {
                                type: "button",
                                text: text("Get user from anonymous ID"),
                                action_id: "get_user",
                            }
                        ]
                    })
                } else if (await canHavePerms(payload.user)) {
                    extraBlocks.push({
                        type: "section",
                        text: mrkdwn(`Ask <@${env.CREATOR}> for user deanonymizing permissions`)
                    })
                }
                await client.views.publish({
                    user_id: payload.user,
                    view: {
                        type: "home",
                        blocks: [
                            {
                                type: "section",
                                text: text("Welcome to Anonymouse!"),
                            },
                            {
                                type: "actions",
                                elements: [
                                    {
                                        type: "button",
                                        text: text("Send a message"),
                                        action_id: "message",
                                    },
                                    {
                                        type: "button",
                                        text: text("Reply to a message"),
                                        action_id: "reply",
                                    }
                                ]
                            },
                            ...extraBlocks,
                            {
                                type: "section",
                                text: mrkdwn(`<${env.GITHUB_LINK}|GitHub>`)
                            }
                        ]
                    }
                })
            })
            .action("message", async ({ payload: event }) => {
                await client.views.open({
                    trigger_id: event.trigger_id,
                    view: {
                        type: "modal",
                        callback_id: "message_modal",
                        title: text("Send Message"),
                        submit: text("Send"),
                        close: text("Cancel"),
                        blocks: [
                            {
                                type: "input",
                                block_id: "conversation",
                                element: {
                                    type: "conversations_select",
                                    action_id: "main",
                                },
                                label: text("Conversation")
                            },
                            {
                                type: "input",
                                block_id: "message",
                                element: {
                                    type: "rich_text_input",
                                    action_id: "main",
                                },
                                label: text("Message")
                            }
                        ]
                    }
                });
            })
            .viewSubmission("message_modal", async ({ payload: event }) => {
                const user = event.user.id;
                const values = event.view.state.values;
                const channel = values.conversation.main.selected_conversation!;
                try {
                    await client.conversations.join({ channel });
                } catch {}
                const text = values.message.main.rich_text_value!;
                const alt = text.elements.map(
                    elem => elem.elements
                        .map(stringifyRichTextSection)
                        .join("")
                ).join("")
                console.log(JSON.stringify({
                    elements: text.elements,
                    channel,
                    alt,
                }, null, 2));
                let replyThread: ChatPostMessageResponse | null = null;
                let replyTo = "";
                if (channel.startsWith("D") || channel.startsWith("U")) {
                    replyThread = await client.chat.postMessage({
                        channel: user,
                        text: "Replies will appear here",
                        unfurl_links: true,
                    });
                    replyTo = ` (reply to ${replyThread.ts})`;
                }
                const thread = await client.chat.postMessage({
                    channel,
                    blocks: [
                        {
                            type: "rich_text",
                            elements: [{
                                type: "rich_text_section",
                                elements: [{
                                    type: "text",
                                    text: `From: ${toAnonymous(user)}${replyTo}`,
                                    style: {
                                        bold: true,
                                    }
                                }]
                            }]
                        },
                        text
                    ],
                    text: `From: ${toAnonymous(user)}${replyTo}; ${alt}`,
                });
                const permalink = await client.chat.getPermalink({
                    channel: thread.channel!,
                    message_ts: thread.ts!
                });
                if (replyThread) {
                    await client.chat.update({
                        channel: replyThread.channel!,
                        ts: replyThread.ts!,
                        text: `Replies to <${permalink.permalink}|your message> will appear here`,
                    });
                } else {
                    await client.chat.postEphemeral({
                        channel: user,
                        user,
                        text: permalink.permalink!,
                    });
                }
            })
            .action("reply", async ({ payload: event }) => {
                await client.views.open({
                    trigger_id: event.trigger_id,
                    view: {
                        type: "modal",
                        callback_id: "reply_modal",
                        title: text("Send Message"),
                        submit: text("Send"),
                        close: text("Cancel"),
                        blocks: [
                            {
                                type: "input",
                                block_id: "link",
                                element: {
                                    type: "url_text_input",
                                    action_id: "main",
                                },
                                label: text("Message Link")
                            },
                            {
                                type: "input",
                                block_id: "message",
                                element: {
                                    type: "rich_text_input",
                                    action_id: "main",
                                },
                                label: text("Message")
                            }
                        ]
                    }
                });
            })
            .viewSubmission("reply_modal", async ({ payload: event }) => {
                const user = event.user.id;
                const values = event.view.state.values;
                const url = values.link.main.value!
                const replaced = url.replace(
                    /^https?:\/\/[a-zA-Z0-9-]+\.slack\.com\/archives\/([A-Z0-9]+)\/p([0-9]+)([0-9]{6})\/?$/,
                    "$1/$2.$3"
                );
                if (replaced == url) {
                    return {
                        response_action: "errors",
                        errors: {
                            link: "Unable to parse URL",
                        }
                    } as const;
                }
                const [channel, ts] = replaced.split("/");
                try {
                    await client.conversations.join({ channel });
                } catch {}
                const text = values.message.main.rich_text_value!;
                const alt = text.elements.map(
                    elem => elem.elements
                        .map(stringifyRichTextSection)
                        .join("")
                ).join("")
                console.log(JSON.stringify({
                    elements: text.elements,
                    channel,
                    alt,
                }, null, 2));
                const message = await client.chat.postMessage({
                    channel,
                    blocks: [
                        {
                            type: "rich_text",
                            elements: [{
                                type: "rich_text_section",
                                elements: [{
                                    type: "text",
                                    text: `From: ${toAnonymous(user)}`,
                                    style: {
                                        bold: true,
                                    }
                                }]
                            }]
                        },
                        text
                    ],
                    text: `From: ${toAnonymous(user)}; ${alt}`,
                    thread_ts: ts,
                });
                const permalink = await client.chat.getPermalink({
                    channel: message.channel!,
                    message_ts: message.ts!
                });
                await client.chat.postEphemeral({
                    channel: user,
                    user,
                    text: permalink.permalink!
                });
            })
            .action("get_user", async ({ payload: event }) => {
                await client.views.open({
                    trigger_id: event.trigger_id,
                    view: {
                        type: "modal",
                        callback_id: "get_user_modal",
                        title: text("Get User From Anonymous"),
                        submit: text("Submit"),
                        close: text("Cancel"),
                        blocks: [
                            {
                                type: "input",
                                block_id: "id",
                                element: {
                                    type: "plain_text_input",
                                    action_id: "main",
                                },
                                label: text("Anonymous ID (anon_...)")
                            }
                        ]
                    }
                });
            })
            .viewSubmission("get_user_modal", async ({ payload: event }) => {
                if (!hasPerms(event.user.id)) return;
                const user = event.user.id!;
                const values = event.view.state.values;
                const anonId = values.id.main.value!;
                await client.chat.postEphemeral({
                    channel: user,
                    user,
                    text: `${anonId} = <@${fromAnonymous(anonId)}>`,
                })
            });
        return await app.run(request, ctx);
    },
};