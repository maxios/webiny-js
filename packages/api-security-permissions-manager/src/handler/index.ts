import { Context } from "@webiny/graphql/types";
import { HandlerPlugin } from "@webiny/handler/types";
import { PermissionsManagerMiddlewarePlugin } from "../types";

const getPermissions = async (data, context: Context) => {
    const plugins = context.plugins.byType<PermissionsManagerMiddlewarePlugin>(
        "permissions-manager-middleware"
    );

    for (let i = 0; i < plugins.length; i++) {
        const plugin = plugins[i];
        if (typeof plugin.getPermissions === "function") {
            console.log(`Running "${plugin.name}"`);
            const permissions = await plugin.getPermissions(data, context);
            if (Array.isArray(permissions)) {
                console.log(`Loaded ${permissions.length} permissions.`);
                return permissions;
            }
            console.log(`No permissions loaded.`);
        }
    }

    console.log(`No permissions were loaded after processing all plugins!`);
    return [];
};

const cache = {};

export default (): HandlerPlugin => ({
    type: "handler",
    name: "handler-permissions-manager",
    async handle({ args, context }) {
        const [{ action, ...data }] = args;
        console.log(`event`, args[0]);

        try {
            if (action !== "getPermissions") {
                throw Error(`Unsupported action "${action}"`);
            }

            const cacheKey = data.identity || data.type;

            if (cache[cacheKey]) {
                return { error: false, data: cache[cacheKey] };
            }

            cache[cacheKey] = await getPermissions(data, context);

            return { error: false, data: cache[cacheKey] || [] };
        } catch (err) {
            console.log(err);
            return {
                error: {
                    message: err.message
                },
                data: null
            };
        }
    }
});