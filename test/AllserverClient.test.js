const assert = require("assert");

const VoidClientTransport = require("../src/client/ClientTransport").compose({
    props: {
        uri: "void://localhost",
    },
    methods: {
        introspect() {},
        call() {},
    },
});
const AllserverClient = require("..").AllserverClient.deepConf({
    transports: [{ schema: "void", Transport: VoidClientTransport }], // added one more known schema
});
const p = Symbol.for("AllserverClient");

describe("AllserverClient", () => {
    afterEach(() => {
        // clean introspection cache
        AllserverClient.compose.methods._introspectionCache = new Map();
    });

    describe("#init", () => {
        it("should throw if no uri and no transport", () => {
            assert.throws(() => AllserverClient(), /uri/);
        });

        it("should throw if uri schema is not supported", () => {
            assert.throws(() => AllserverClient({ uri: "unexist://bla" }), /schema/i);
        });

        it("should work with http", () => {
            const client = AllserverClient({ uri: "http://bla" });
            assert(client[p].transport._fetch); // duck typing
        });

        it("should work with grpc", () => {
            const client = AllserverClient({ uri: "grpc://bla" });
            assert(client[p].transport._grpc); // duck typing
        });

        it("should work with third party added transports supported", () => {
            const client = AllserverClient({ uri: "void://bla" });
            assert.strictEqual(client[p].transport.uri, "void://bla");
        });
    });

    describe("#introspect", () => {
        it("should not throw if underlying transport fails to connect", async () => {
            const MockedTransport = VoidClientTransport.methods({
                introspect: () => Promise.reject(new Error("Cannot reach server")),
            });

            const result = await AllserverClient({ transport: MockedTransport() }).introspect();
            assert.strictEqual(result.success, false);
            assert.strictEqual(result.code, "INTROSPECTION_FAILED");
            assert.strictEqual(result.message, "Couldn't introspect void://localhost");
            assert.strictEqual(result.error.message, "Cannot reach server");
        });

        it("should not throw if underlying transport returns malformed introspection", async () => {
            const MockedTransport = VoidClientTransport.methods({
                introspect: () => ({
                    success: true,
                    code: "OK",
                    message: "Introspection as JSON string",
                    procedures: "bad food",
                }),
            });

            const result = await AllserverClient({ transport: MockedTransport() }).testMethod();
            assert.strictEqual(result.success, false);
            assert.strictEqual(result.code, "ALLSERVER_MALFORMED_INTROSPECTION");
            assert.strictEqual(result.message, "Malformed introspection from void://localhost");
            assert.strictEqual(result.error.message, "Unexpected token b in JSON at position 0");
        });

        it("should not throw if underlying transport returns introspection in a wrong format", async () => {
            const MockedTransport = VoidClientTransport.methods({
                introspect: () => ({
                    success: true,
                    code: "OK",
                    message: "Introspection as JSON string",
                    procedures: "42",
                }),
            });

            const result = await AllserverClient({ transport: MockedTransport() }).testMethod();
            assert.strictEqual(result.success, false);
            assert.strictEqual(result.code, "ALLSERVER_MALFORMED_INTROSPECTION");
            assert.strictEqual(result.message, "Malformed introspection from void://localhost");
            assert(!result.error);
        });
    });

    describe("#call", () => {
        it("should throw if underlying transport fails to connect and neverThrow=false", async () => {
            const MockedTransport = VoidClientTransport.methods({
                call: () => Promise.reject(new Error("Cannot reach server")),
            });

            await assert.rejects(
                AllserverClient({ transport: MockedTransport(), neverThrow: false }).call(),
                /Cannot reach server/
            );
        });

        it("should throw if transport 'before' or 'after' middlewares throw and neverThrow=false", async () => {
            let MockedTransport = VoidClientTransport.methods({
                before() {
                    throw new Error("before threw");
                },
            });

            await assert.rejects(
                AllserverClient({ transport: MockedTransport(), neverThrow: false }).call(),
                /before threw/
            );

            MockedTransport = VoidClientTransport.methods({
                after() {
                    throw new Error("after threw");
                },
            });

            await assert.rejects(
                AllserverClient({ transport: MockedTransport(), neverThrow: false }).call(),
                /after threw/
            );
        });

        it("should not throw if neverThrow enabled (default behaviour)", async () => {
            const MockedTransport = VoidClientTransport.methods({
                async introspect() {
                    return {
                        success: true,
                        code: "OK",
                        message: "Ok",
                        procedures: JSON.stringify({ foo: "function" }),
                    };
                },
                call: () => Promise.reject(new Error("Cannot reach server")),
            });

            const result = await AllserverClient({ transport: MockedTransport() }).call("foo", {});
            assert.strictEqual(result.success, false);
            assert.strictEqual(result.code, "ALLSERVER_PROCEDURE_UNREACHABLE");
            assert.strictEqual(result.message, "Couldn't reach remote procedure: foo");
            assert.strictEqual(result.error.message, "Cannot reach server");
        });

        it("should not throw if neverThrow enabled and the method is not present", async () => {
            const MockedTransport = VoidClientTransport.methods({
                call: () => Promise.reject(new Error("Shit happens too")),
            });

            const client = AllserverClient({ transport: MockedTransport() });
            assert.strictEqual(Reflect.has(client, "foo"), false); // don't have it
            const result = await client.call("foo", {});
            assert.strictEqual(Reflect.has(client, "foo"), false); // still don't have it
            assert.strictEqual(result.success, false);
            assert.strictEqual(result.code, "ALLSERVER_PROCEDURE_UNREACHABLE");
            assert.strictEqual(result.message, "Couldn't reach remote procedure: foo");
            assert.strictEqual(result.error.message, "Shit happens too");
        });
    });

    describe("dynamicMethods", () => {
        it("should not do dynamic RPC based on object property names", () => {
            const client = AllserverClient({ dynamicMethods: false, uri: "void://bla" });
            assert.throws(() => client.thisMethodDoesNotExist());
        });

        it("should do dynamic RPC based on object property names", async () => {
            const client = AllserverClient({ autoIntrospect: false, uri: "void://bla" });
            await client.thisMethodDoesNotExist();
        });
    });

    describe("nameMapper", () => {
        it("should map and filter names", async () => {
            const MockedTransport = VoidClientTransport.methods({
                async introspect() {
                    return {
                        success: true,
                        code: "OK",
                        message: "Ok",
                        procedures: JSON.stringify({ "get-rates": "function", "hide-me": "function" }),
                    };
                },
                async call(procedureName, arg) {
                    assert.strictEqual(procedureName, "getRates");
                    assert.deepStrictEqual(arg, { a: 1 });
                    return { success: true, code: "CALLED", message: "A is good", b: 42 };
                },
            });

            const nameMapper = (name) => name !== "hide-me" && name.replace(/(-\w)/g, (k) => k[1].toUpperCase());
            const client = AllserverClient({ transport: MockedTransport(), nameMapper });
            assert.strictEqual(Reflect.has(client, "getRates"), false); // dont have it yet
            const result = await client.getRates({ a: 1 });
            assert.strictEqual(Reflect.has(client, "getRates"), true); // have it now!
            assert.deepStrictEqual(result, { success: true, code: "CALLED", message: "A is good", b: 42 });
        });
    });

    describe("client transport middleware", () => {
        describe("before", () => {
            it("should call 'before'", async () => {
                const MockedTransport = VoidClientTransport.methods({
                    async introspect() {
                        return {
                            success: true,
                            code: "OK",
                            message: "Ok",
                            procedures: JSON.stringify({ getRates: "function" }),
                        };
                    },
                    async call(procedureName, arg) {
                        assert.strictEqual(procedureName, "getRates");
                        assert.deepStrictEqual(arg, { a: 1 });
                        return { success: true, code: "CALLED", message: "A is good", b: 42 };
                    },
                    before(ctx) {
                        assert.strictEqual(ctx.procedureName, "getRates");
                        assert.deepStrictEqual(ctx.arg, { a: 1 });
                        beforeCalled = true;
                    },
                });

                let beforeCalled = false;
                const client = AllserverClient({
                    transport: MockedTransport(),
                });
                const result = await client.getRates({ a: 1 });
                assert.deepStrictEqual(result, { success: true, code: "CALLED", message: "A is good", b: 42 });
                assert(beforeCalled);
            });

            it("should allow result override in 'before'", async () => {
                const client = AllserverClient({
                    transport: VoidClientTransport({
                        before() {
                            return "Override result";
                        },
                    }),
                });
                const result = await client.foo();
                assert.deepStrictEqual(result, "Override result");
            });

            it("should handle rejections from 'before'", async () => {
                const err = new Error("'before' is throwing");
                const client = AllserverClient({
                    transport: VoidClientTransport({
                        before() {
                            throw err;
                        },
                    }),
                });
                const result = await client.foo();
                assert.deepStrictEqual(result, {
                    success: false,
                    code: "ALLSERVER_CLIENT_BEFORE_ERROR",
                    message: "The 'before' middleware threw while calling: foo",
                    error: err,
                });
            });

            it("should override code if 'before' error has it", async () => {
                const err = new Error("'before' is throwing");
                err.code = "OVERRIDE_CODE";
                const client = AllserverClient({
                    transport: VoidClientTransport({
                        before() {
                            throw err;
                        },
                    }),
                });
                const result = await client.foo();
                assert.deepStrictEqual(result, {
                    success: false,
                    code: "OVERRIDE_CODE",
                    message: "'before' is throwing",
                    error: err,
                });
            });
        });

        describe("after", () => {
            it("should call 'after'", async () => {
                const MockedTransport = VoidClientTransport.methods({
                    async introspect() {
                        return {
                            success: true,
                            code: "OK",
                            message: "Ok",
                            procedures: JSON.stringify({ getRates: "function" }),
                        };
                    },
                    async call(procedureName, arg) {
                        assert.strictEqual(procedureName, "getRates");
                        assert.deepStrictEqual(arg, { a: 1 });
                        return { success: true, code: "CALLED", message: "A is good", b: 42 };
                    },

                    after(ctx) {
                        assert.strictEqual(ctx.procedureName, "getRates");
                        assert.deepStrictEqual(ctx.arg, { a: 1 });
                        assert.deepStrictEqual(ctx.result, {
                            success: true,
                            code: "CALLED",
                            message: "A is good",
                            b: 42,
                        });
                        afterCalled = true;
                    },
                });

                let afterCalled = false;
                const client = AllserverClient({
                    transport: MockedTransport(),
                });
                const result = await client.getRates({ a: 1 });
                assert.deepStrictEqual(result, { success: true, code: "CALLED", message: "A is good", b: 42 });
                assert(afterCalled);
            });

            it("should allow result override in 'after'", async () => {
                const client = AllserverClient({
                    transport: VoidClientTransport({
                        after() {
                            return "Override result";
                        },
                    }),
                });
                const result = await client.foo();
                assert.deepStrictEqual(result, "Override result");
            });

            it("should handle rejections from 'after'", async () => {
                const err = new Error("'after' is throwing");
                const client = AllserverClient({
                    transport: VoidClientTransport({
                        after() {
                            throw err;
                        },
                    }),
                });
                const result = await client.foo();
                assert.deepStrictEqual(result, {
                    success: false,
                    code: "ALLSERVER_CLIENT_AFTER_ERROR",
                    message: "The 'after' middleware threw while calling: foo",
                    error: err,
                });
            });

            it("should override code if 'after' error has it", async () => {
                const err = new Error("'after' is throwing");
                err.code = "OVERRIDE_CODE";
                const client = AllserverClient({
                    transport: VoidClientTransport({
                        after() {
                            throw err;
                        },
                    }),
                });
                const result = await client.foo();
                assert.deepStrictEqual(result, {
                    success: false,
                    code: "OVERRIDE_CODE",
                    message: "'after' is throwing",
                    error: err,
                });
            });
        });

        describe("before+after", () => {
            it("should call 'after' even if 'before' throws", async () => {
                let afterCalled = false;
                const err = new Error("'before' is throwing");
                const client = AllserverClient({
                    transport: VoidClientTransport({
                        before() {
                            throw err;
                        },
                        after() {
                            afterCalled = true;
                        },
                    }),
                });
                const result = await client.foo();
                assert.deepStrictEqual(result, {
                    success: false,
                    code: "ALLSERVER_CLIENT_BEFORE_ERROR",
                    message: "The 'before' middleware threw while calling: foo",
                    error: err,
                });
            });
        });
    });

    describe("autoIntrospect", () => {
        it("should introspect and add methods before call", async () => {
            const MockedTransport = VoidClientTransport.methods({
                async introspect() {
                    return {
                        success: true,
                        code: "OK",
                        message: "Ok",
                        procedures: JSON.stringify({ foo: "function" }),
                    };
                },
                async call(procedureName, arg) {
                    assert.strictEqual(procedureName, "foo");
                    assert.deepStrictEqual(arg, { a: 1 });
                    return { success: true, code: "CALLED_A", message: "A is good", b: 42 };
                },
            });

            const client = AllserverClient({ transport: MockedTransport() });
            assert.strictEqual(Reflect.has(client, "foo"), false); // dont have it yet
            const result = await client.foo({ a: 1 });
            assert.strictEqual(Reflect.has(client, "foo"), true); // have it now!
            assert.deepStrictEqual(result, { success: true, code: "CALLED_A", message: "A is good", b: 42 });
        });

        it("should attempt calling if introspection fails", async () => {
            const MockedTransport = VoidClientTransport.methods({
                introspect() {
                    return Promise.reject(new Error("Couldn't introspect"));
                },
                call(procedureName, arg) {
                    assert.strictEqual(procedureName, "foo");
                    assert.deepStrictEqual(arg, { a: 1 });
                    return { success: true, code: "CALLED_A", message: "A is good", b: 42 };
                },
            });

            const client = AllserverClient({ transport: MockedTransport() });
            assert.strictEqual(Reflect.has(client, "foo"), false); // don't have it
            const result = await AllserverClient({ transport: MockedTransport() }).foo({ a: 1 });
            assert.strictEqual(Reflect.has(client, "foo"), false); // still don't have it
            assert.deepStrictEqual(result, { success: true, code: "CALLED_A", message: "A is good", b: 42 });
        });

        it("should not override existing methods", async () => {
            const MockedTransport = VoidClientTransport.methods({
                async introspect() {
                    return {
                        success: true,
                        code: "OK",
                        message: "Ok",
                        procedures: JSON.stringify({ foo: "function" }),
                    };
                },
                async call() {
                    assert.fail("should not call transport");
                },
            });

            function foo(arg) {
                assert.strictEqual(arg && arg.a, 1);
                return {
                    success: true,
                    code: "CACHED",
                    message: "The reply mimics memory caching",
                    b: 2,
                };
            }

            const client = AllserverClient.methods({ foo }).create({ transport: MockedTransport() });
            assert.strictEqual(client.foo, foo);
            const result = await client.foo({ a: 1 });
            assert.strictEqual(client.foo, foo);
            assert.deepStrictEqual(result, {
                success: true,
                code: "CACHED",
                message: "The reply mimics memory caching",
                b: 2,
            });
        });

        it("should introspect same uri only once", async () => {
            let introspectionCalls = 0;
            const MockedTransport = VoidClientTransport.methods({
                async introspect() {
                    introspectionCalls += 1;
                    return {
                        success: true,
                        code: "OK",
                        message: "Ok",
                        procedures: JSON.stringify({ foo: "function" }),
                    };
                },
                async call() {
                    return { success: true, code: "CALLED_A", message: "A is good", b: 42 };
                },
            });

            for (let i = 1; i <= 2; i += 1) {
                const client = AllserverClient({ transport: MockedTransport({ uri: "void://very-unique-address-1" }) });
                assert.strictEqual(Reflect.has(client, "foo"), false); // dont have it yet
                const result = await client.foo({ a: 1 });
                assert.strictEqual(Reflect.has(client, "foo"), true); // have it now!
                assert.deepStrictEqual(result, { success: true, code: "CALLED_A", message: "A is good", b: 42 });
            }

            assert.strictEqual(introspectionCalls, 1);
        });

        it("should re-introspect failed introspections", async () => {
            let introspectionCalls = 0;
            const MockedTransport = VoidClientTransport.methods({
                async introspect() {
                    introspectionCalls += 1;
                    throw new Error("Shit happens twice");
                },
                async call() {
                    return { success: true, code: "CALLED_A", message: "A is good", b: 42 };
                },
            });

            for (let i = 1; i <= 2; i += 1) {
                const client = AllserverClient({
                    transport: MockedTransport({ uri: "void://very-unique-address-2" }),
                });
                assert.strictEqual(Reflect.has(client, "foo"), false); // dont have it
                const result = await client.foo({ a: 1 });
                assert.strictEqual(Reflect.has(client, "foo"), false); // still don't have it
                assert.deepStrictEqual(result, { success: true, code: "CALLED_A", message: "A is good", b: 42 });
            }

            assert.strictEqual(introspectionCalls, 2);
        });

        it("should not auto introspect if asked so", (done) => {
            const MockedTransport = VoidClientTransport.methods({
                async introspect() {
                    done(new Error("Must not attempt introspection"));
                },
                async call() {
                    return { success: true, code: "CALLED_A", message: "A is good", b: 42 };
                },
            });

            const client = AllserverClient({
                autoIntrospect: false,
                transport: MockedTransport({ uri: "void://very-unique-address-3" }),
            });
            assert.strictEqual(Reflect.has(client, "foo"), false); // dont have it
            client
                .foo({ a: 1 })
                .then((result) => {
                    assert.strictEqual(Reflect.has(client, "foo"), false); // still don't have it
                    assert.deepStrictEqual(result, { success: true, code: "CALLED_A", message: "A is good", b: 42 });
                    done();
                })
                .catch(done);
        });
    });

    describe("#defaults", () => {
        it("should work", () => {
            const NewClient = AllserverClient.defaults({
                neverThrow: false,
                dynamicMethods: false,
                autoIntrospect: false,
                nameMapper: (a) => a,
            });

            function protectedsAreOk(protecteds) {
                assert.strictEqual(protecteds.neverThrow, false);
                assert.strictEqual(protecteds.dynamicMethods, false);
                assert.strictEqual(protecteds.autoIntrospect, false);
                assert.strictEqual(typeof protecteds.nameMapper, "function");
            }

            protectedsAreOk(NewClient.compose.deepProperties[p]);
            protectedsAreOk(NewClient({ uri: "void://bla" })[p]);
        });

        it("should create new factory", () => {
            assert.notStrictEqual(AllserverClient, AllserverClient.defaults());
        });
    });
});
