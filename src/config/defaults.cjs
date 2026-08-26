// Shipped defaults for the command table.
//
// This used to be config.json. It is JavaScript now for one reason: the
// database is the source of truth and the dashboard is how you change things,
// so a JSON file sitting next to the code invited the opposite — editing a
// file the operator would then lose on the next `git pull`.
//
// Nothing here is ever written to. Whatever the operator changes from the
// dashboard is stored as an override in `bot_settings` and layered on top by
// src/config/runtime-config.cjs, which means:
//
//   * an update that adds a new command still gets its default permission,
//   * nothing has to rewrite a file that is checked into the repo,
//   * a change is live on the very next message.
//
// Group sub-commands are addressed as "group:<name>" everywhere else; the
// nesting here is only so the group entry can carry a default_permission.

const PREFIX = "!";

const COMMAND_PERMISSIONS = Object.freeze(
  {
    "ping": "MEMBERS",
    "gemini": "MEMBERS",
    "qr": "MEMBERS",
    "shortlink": "MEMBERS",
    "schedule": "ADMINS_OWNER",
    "weather": "MEMBERS",
    "prayer": "MEMBERS",
    "tagadmins": "MEMBERS",
    "help": "MEMBERS",
    "score": "MEMBERS",
    "stt": "MEMBERS",
    "tts": "MEMBERS",
    "todo": "MEMBERS",
    "notes": "MEMBERS",
    "debt": "MEMBERS",
    "calc": "MEMBERS",
    "loop": "MEMBERS",
    "rand": "MEMBERS",
    "poll": "MEMBERS",
    "memory": "MEMBERS",
    "mod": "ADMINS_OWNER",
    "blacklist": "ADMINS_OWNER",
    "listschedules": "ADMINS_OWNER",
    "deleteschedule": "ADMINS_OWNER",
    "autoschedule": "OWNER_ONLY",
    "perm": "OWNER_ONLY",
    "setprefix": "OWNER_ONLY",
    "restart": "OWNER_ONLY",
    "shutdown": "OWNER_ONLY",
    "status": "OWNER_ONLY",
    "block": "OWNER_ONLY",
    "unblock": "OWNER_ONLY",
    "group": {
      "default_permission": "ADMINS_OWNER",
      "sub_commands": {
        "approveall": "ADMINS_OWNER",
        "setname": "ADMINS_OWNER",
        "setpp": "ADMINS_OWNER",
        "kick": "ADMINS_OWNER",
        "add": "ADMINS_OWNER",
        "promote": "ADMINS_OWNER",
        "demote": "ADMINS_OWNER",
        "removeall": "OWNER_ONLY",
        "setrules": "ADMINS_ONLY",
        "antilink": "ADMINS_ONLY",
        "media": "ADMINS_ONLY",
        "setwarn": "ADMINS_ONLY",
        "warn": "ADMINS_ONLY",
        "warns": "ADMINS_OWNER",
        "clearwarns": "ADMINS_ONLY",
        "rules": "MEMBERS",
        "notes": "MEMBERS",
        "members": "MEMBERS",
        "tagadmins": "MEMBERS",
        "welcome": "ADMINS_OWNER",
        "blacklist": "ADMINS_OWNER",
        "save": "ADMINS_OWNER",
        "deletenote": "ADMINS_OWNER",
        "remove": "ADMINS_ONLY",
        "all": "MEMBERS"
      }
    }
  }
);

module.exports = {
  prefix: PREFIX,
  command_permissions: COMMAND_PERMISSIONS,
};
