//
// AzureMonitorAddonForSplunk
//
// Copyright (c) Microsoft Corporation
//
// All rights reserved. 
// 
// MIT License
//
// Permission is hereby granted, free of charge, to any person obtaining a copy 
// of this software and associated documentation files (the ""Software""), to deal 
// in the Software without restriction, including without limitation the rights 
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell 
// copies of the Software, and to permit persons to whom the Software is furnished 
// to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in all 
// copies or substantial portions of the Software.

// THE SOFTWARE IS PROVIDED *AS IS*, WITHOUT WARRANTY OF ANY KIND, EXPRESS OR 
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS 
// FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR 
// COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER 
// IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION 
// WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

/* jshint unused: true */

var splunkjs = require("splunk-sdk");
var ModularInputs = splunkjs.ModularInputs;
var ModularInput = ModularInputs.ModularInput;
var Logger = ModularInputs.Logger;
var Scheme = ModularInputs.Scheme;
var Event = ModularInputs.Event;
var Argument = ModularInputs.Argument;

var _ = require('underscore');
var AMQPClient = require('amqp10').Client;
var Policy = require('amqp10').Policy;
var Promise = require('bluebird');

var subs = require('./subs');
var strings = require('./strings');
strings.stringFormat();
var allHubs = require('./hubs.json');
var categories = require('./logCategories.json');
var spawnSync = require("child_process").spawnSync;
var async = require('async');
var path = require('path');
var environments = require('./environments.json');

var secretMask = '********';

exports.getOrStoreSecrets = function (name, singleInput, done) {

    // make a copy of singleInput
    var mySingleInput = JSON.parse(JSON.stringify(singleInput));

    var inputDefinition = ModularInput._inputDefinition;
    var session_key = inputDefinition.metadata.session_key;
    var service = new splunkjs.Service({ sessionKey: session_key });
    var storagePasswords = service.storagePasswords({ 'app': 'TA-Azure_Monitor' });

    var propsAppId = {};
    var propsAppKey = {};
    if (~name.indexOf('azure_activity_log:')) {
        propsAppId.name = 'AzureMonitorActivityLogAppID-' + name.replace(":", "_");
        propsAppKey.name = 'AzureMonitorActivityLogAppKey-' + name.replace(":", "_");
    } else {
        propsAppId.name = 'AzureMonitorDiagnosticLogsAppID-' + name.replace(":", "_");
        propsAppKey.name = 'AzureMonitorDiagnosticLogsAppKey-' + name.replace(":", "_");
    }
    propsAppId.password = singleInput.SPNApplicationId;
    propsAppKey.password = singleInput.SPNApplicationKey;

    if (_.isUndefined(singleInput.SPNApplicationId) && _.isUndefined(singleInput.SPNApplicationKey)) {
        done(null, singleInput);
    } else if (singleInput.SPNApplicationId === secretMask) {

        async.parallel([
            function (callback) {

                storagePasswords.fetch(function (err, storagePasswords) {
                    if (err) {
                        callback(err);
                    } else {
                        var oldPw = storagePasswords.item(':' + propsAppId.name.substr(0, propsAppId.name.indexOf('-')) + ':');
                        var pw = storagePasswords.item(':' + propsAppId.name + ':');
                        if ((!_.isUndefined(oldPw) || !_.isNull(oldPw)) && (_.isUndefined(pw) || _.isNull(pw))) {
                            // Create new unique storage password entry based on old password entry
                            modifyStoragePassword(name, storagePasswords, oldPw, propsAppId.name);
                        }
                        if (_.isUndefined(pw) || _.isNull(pw)) {
                            callback({ status: 404 });
                        } else {
                            Logger.debug(name, String.format('password object: {0}', JSON.stringify(pw)));
                            callback(null, pw._properties.clear_password);
                        }
                    }
                });

            },
            function (callback) {

                storagePasswords.fetch(function (err, storagePasswords) {
                    if (err) {
                        callback(err);
                    } else {
                        var oldPw = storagePasswords.item(':' + propsAppKey.name.substr(0, propsAppKey.name.indexOf('-')) + ':');
                        var pw = storagePasswords.item(':' + propsAppKey.name + ':');
                        if ((!_.isUndefined(oldPw) || !_.isNull(oldPw)) && (_.isUndefined(pw) || _.isNull(pw))) {
                            // Create new unique storage password entry based on old password entry
                            modifyStoragePassword(name, storagePasswords, oldPw, propsAppKey.name);
                        }
                        if (_.isUndefined(pw) || _.isNull(pw)) {
                            callback({ status: 404 });
                        } else {
                            Logger.debug(name, String.format('password object: {0}', JSON.stringify(pw)));
                            callback(null, pw._properties.clear_password);
                        }
                    }
                });

            }

        ],
            function (err, result) {

                if (err) {
                    Logger.error(name, String.format('Error retrieving passwords: {0}', JSON.stringify(err)));
                    done(err);
                } else {

                    mySingleInput.SPNApplicationId = result[0];
                    mySingleInput.SPNApplicationKey = result[1];

                    done(null, mySingleInput);
                }

            });

    } else {

        //store both the appid and the appkey as passwords in StoragePasswords
        async.parallel([
            function (callback) {
                createOrUpdateStoragePassword(name, storagePasswords, propsAppId, function (err, result) {
                    callback(err, result);
                });
            },
            function (callback) {
                createOrUpdateStoragePassword(name, storagePasswords, propsAppKey, function (err, result) {
                    callback(err, result);
                });
            }
        ],
            function (err, result) {

                if (err) {
                    Logger.error(name, String.format('Error creating storage passwords: {0}', JSON.stringify(err)));
                    done(err);
                } else {
                    maskAppIdAndKeySync(name, session_key);

                    done(null, singleInput);
                }

            });

    }
};

function modifyStoragePassword(name, storagePasswords, oldPassword, newUsername) {

    Logger.debug(name, String.format('Updating storage password. Old username: {0}, new username {1}', oldPassword.name, newUsername));

    storagePasswords.create({
        name: newUsername,
        password: oldPassword._properties.clear_password},
        function (err, newUsername) {
        if (err) {
            if (err.status === 409) {
                callback(null, null);   // ignore duplicate already exists
            } else {
                callback(err);
            }
        }
        else {
            callback(null, newUsername);
        }
    });

}

function maskAppIdAndKeySync(name, session_key) {

    var fullpath = path.join(process.env.SPLUNK_HOME, 'bin', 'splunk');
    Logger.debug(name, String.format('program path and name is: {0}', fullpath));

    try {
        process.chdir(__dirname);

        var args = [];
        args.push('cmd', 'python', 'mask_secret.py');
        args.push('-n', name);
        args.push('-k', session_key);

        var masker = spawnSync(fullpath, args, { encoding: 'utf8' });
        Logger.debug(name, 'stdout: ' + masker.stdout);
        Logger.debug(name, 'stderr: ' + masker.stderr);
    }
    catch (err) {
        Logger.error(name, String.format('Caught error in maskAppIdAndKeySync: {0}', JSON.stringify(err)));
    }
}

function createOrUpdateStoragePassword(name, storagePasswords, props, done) {

    async.waterfall([
        function (callback) {
            storagePasswords.fetch(function (err, storagePasswords) {
                if (err) {
                    callback(err);
                } else {
                    var pw = storagePasswords.item(':' + props.name + ':');
                    if (_.isUndefined(pw) || _.isNull(pw)) {
                        callback(null, false);
                    } else {
                        callback(null, true);
                    }
                }
            });
        },
        function (pwExists, callback) {
            if (pwExists) {
                storagePasswords.del(':' + props.name + ':', {}, function (err) {
                    if (err) {
                        callback(err);
                    } else {
                        Logger.debug(name, 'password was deleted');
                        callback(null);
                    }
                });
            } else {
                Logger.debug(name, 'password does not exist');
                callback(null);
            }
        },
        function (callback) {
            Logger.debug(name, 'creating new password');
            storagePasswords.create(props, function (err, newPassword) {
                if (err) {
                    if (err.status === 409) {
                        callback(null, null);   // ignore duplicate already exists
                    } else {
                        callback(err);
                    }
                }
                else {
                    callback(null, newPassword);
                }
            });
        }

    ], function (err, result) {
        if (err) {
            Logger.error(name, String.format('Error {0} in the password waterfall: {1}', err.status, err.data.messages.text));
        } else {
            Logger.debug(name, String.format('New password was created'));
        }
        done(err, result);
    });
}


function getElement(resourceId, elementRegex) {

    if (resourceId.length > 0) {
        var match = resourceId.match(elementRegex);
        if (!_.isNull(match)) {
            return match[1];
        }
    }

    return '';
}

function getAMDLsourcetype(category, resourceType) {

    if (resourceType !== '') {
        testSourceType = categories[resourceType + '/' + category];
        if (!_.isUndefined(testSourceType) && testSourceType.length > 0) {
            return testSourceType;
        }
    }

    return "amdl:diagnosticLogs";
}

function getAMALsourcetype(name, operationName) {

    if (operationName === '') {
        return 'amal:activityLog';
    }

    var splits = operationName.split("/");

    if (splits.length < 3) {

        // this catches the free form text in some ASC recommendations
        // and the one starting with TCP/IP

        return 'amal:ascRecommendation';

    } else if (splits.length >= 3) {

        var provider = splits[0].toUpperCase();
        var type = splits[1].toUpperCase();
        var operation = splits[2].toUpperCase();

        switch (provider) {
            case 'MICROSOFT.SERVICEHEALTH':
                return 'amal:serviceHealth';
            case 'MICROSOFT.RESOURCEHEALTH':
                return 'amal:resourceHealth';
            case 'MICROSOFT.INSIGHTS':
                if (type == 'AUTOSCALESETTINGS') {
                    return 'amal:autoscaleSettings';
                } else if (type == 'ALERTRULES') {
                    return 'amal:ascAlert';
                } else {
                    return 'amal:insights';
                }
                break;
            case 'MICROSOFT.SECURITY':
                if (type == 'APPLICATIONWHITELISTINGS') {
                    if (operation == 'ACTION') {
                        return 'amal:ascAlert';
                    } else {
                        return 'amal:security';
                    }
                } else if (type == 'LOCATIONS') {
                    return 'amal:security';
                } else if (type == 'TASKS') {
                    return 'amal:ascRecommendation';
                }
                break;
            default: {
                return 'amal:administrative';
            }
        }

    }

    return 'amal:activityLog';
}

var messageHandler = function (name, data, eventWriter) {

    Logger.debug(name, String.format('streamEvents.messageHandler got data for data input named: {0}', name));

    // initialize identifiers
    var subscriptionId = '';
    var resourceGroup = '';
    var resourceName = '';
    var resourceType = '';

    // get tenantId if it exists
    var tenantId = (data.tenantId || '').toUpperCase();

    // get resourceId if it exists
    var resourceId = (data.resourceId || '').toUpperCase();

    // get category if it exists
    var category = (data.category || '').toUpperCase();

    // initialize splunk sourceType
    var sourceType = '';

    // set a couple of flags
    var tenantBased = (tenantId.length > 0);
    var activityLog = (~name.indexOf('azure_activity_log:'));

    if (tenantBased) {

        var providerName = getElement(resourceId, 'PROVIDERS\/(.*?)(?:$)');
        sourceType = getAMDLsourcetype(category, providerName);

    } else { // subscription-based

        // parse values from resourceId
        subscriptionId = getElement(resourceId, 'SUBSCRIPTIONS\/(.*?)\/');
        resourceGroup = getElement(resourceId, 'SUBSCRIPTIONS\/(?:.*?)\/RESOURCEGROUPS\/(.*?)\/');
        resourceType = getElement(resourceId, 'PROVIDERS\/(.*?\/.*?)(?:\/)');
        resourceName = getElement(resourceId, 'PROVIDERS\/(?:.*?\/.*?\/)(.*?)(?:\/|$)');

        if (activityLog) {

            var operationNameRaw = data.operationName.toUpperCase() || '';
            var operationName = '';
            if (_.isString(operationNameRaw)) {
                operationName = operationNameRaw;
            } else if (_.isObject(operationNameRaw)) {
                operationName = operationNameRaw.value.toUpperCase() || '';
            } else {
                operationName = "MICROSOFT.BOGUS/THISISANERROR/ACTION";
            }
            sourceType = getAMALsourcetype(name, operationName);

        } else {

            sourceType = getAMDLsourcetype(category, resourceType);

        }
    }

    // add identifiers as standard properties to the splunk event
    if (subscriptionId.length > 0) {
        data.am_subscriptionId = subscriptionId;
    }
    if (resourceGroup.length > 0) {
        data.am_resourceGroup = resourceGroup;
    }
    if (resourceName.length > 0) {
        data.am_resourceName = resourceName;
    }
    if (resourceType.length > 0) {
        data.am_resourceType = resourceType;
    }
    if (tenantId.length > 0) {
        data.am_tenantId = tenantId;
    }
    if (category.length > 0) {
        data.am_category = category;
    }

    Logger.debug(name, String.format('streamEvents.messageHandler event identifiers are: Tenant ID: {4}, Subscription ID: {0}, resourceType: {1}, resourceName: {2}, sourceType: {3}',
        subscriptionId, resourceType, resourceName, sourceType, tenantId));

    var curEvent = new Event({
        stanza: name,
        sourcetype: sourceType,
        data: data
    });

    try {
        eventWriter.writeEvent(curEvent);
        Logger.debug(name, String.format('streamEvents.messageHandler wrote an event'));
    }
    catch (e) {
        errorFound = true; // Make sure we stop streaming if there's an error at any point
        Logger.error(name, e.message);
        done(e);

        // we had an error; die
        return;
    }

};

exports.getScheme = function (schemeName, schemeDesc) {

    var scheme = new Scheme(schemeName);

    // scheme properties
    scheme.description = schemeDesc;
    scheme.useExternalValidation = true;  // if true, must define validateInput method
    scheme.useSingleInstance = false;      // if true, all instances of mod input passed to
    //   a single script instance; if false, user 
    //   can set the interval parameter under "more settings"

    // add arguments
    scheme.args = [
        new Argument({
            name: "SPNTenantID",
            dataType: Argument.dataTypeString,
            description: "Azure AD tenant containing the service principal.",
            requiredOnCreate: false,
            requiredOnEdit: false
        }),
        new Argument({
            name: "SPNApplicationId",
            dataType: Argument.dataTypeString,
            description: "Service principal application id (aka client id).",
            requiredOnCreate: false,
            requiredOnEdit: false
        }),
        new Argument({
            name: "SPNApplicationKey",
            dataType: Argument.dataTypeString,
            description: "Service principal password (aka client secret).",
            requiredOnCreate: false,
            requiredOnEdit: false
        }),
        new Argument({
            name: "eventHubNamespace",
            dataType: Argument.dataTypeString,
            description: "Azure Event Hub namespace.",
            requiredOnCreate: true,
            requiredOnEdit: false
        }),
        new Argument({
            name: "vaultName",
            dataType: Argument.dataTypeString,
            description: "Key vault name.",
            requiredOnCreate: true,
            requiredOnEdit: false
        }),
        new Argument({
            name: "secretName",
            dataType: Argument.dataTypeString,
            description: "Name of the secret containing SAS key & value.",
            requiredOnCreate: true,
            requiredOnEdit: false
        }),
        new Argument({
            name: "secretVersion",
            dataType: Argument.dataTypeString,
            description: "Version of the secret containing SAS key & value.",
            requiredOnCreate: true,
            requiredOnEdit: false
        })
        // other arguments here
    ];

    return scheme;
};

exports.streamEvents = function (name, singleInput, eventWriter, done) {

    Logger.debug(name, 'Streaming events from Azure Event Hubs until silence for 5 seconds.');
    Logger.debug(name, String.format('single input = {0}', JSON.stringify(singleInput)));

    // setup
    var eventHubNamespace = singleInput.eventHubNamespace;
    var SPNName = singleInput.SPNApplicationId;
    var SPNPassword = singleInput.SPNApplicationKey;
    var SPNTenantID = singleInput.SPNTenantID;
    var vaultName = singleInput.vaultName;
    var secretName = singleInput.secretName;
    var secretVersion = singleInput.secretVersion;

    // get the list of all of the possible hubs for Azure Monitor
    var hubsToBeQueried = [];
    if (~name.indexOf('azure_activity_log:')) {
        hubsToBeQueried.push('insights-operational-logs');
    } else {
        var hubNames = Object.keys(allHubs);
        hubNames.forEach(function (hubName) {
            hubsToBeQueried.push(hubName);
        });
    }

    // object to hold client objects
    var amqpClients = {};

    var ehErrorHandler = function (hub, myIdx, rx_err) {

        // sample rx_err:
        //{
        //    "name": "AmqpProtocolError",
        //    "message": "amqp:not-found:The messaging entity 'sb://xxxx.servicebus.windows.net/insights-logs-auditevent/consumergroups/$default/partitions/0' could not be found. TrackingId:e256ee5832744807b36a22bb4f411b15_G18, SystemTracker:gateway2, Timestamp:3/1/2018 12:48:29 PM",
        //    "condition": "amqp:not-found",
        //    "description": "The messaging entity 'sb://xxxx.servicebus.windows.net/insights-logs-auditevent/consumergroups/$default/partitions/0' could not be found. TrackingId:e256ee5832744807b36a22bb4f411b15_G18, SystemTracker:gateway2, Timestamp:3/1/2018 12:48:29 PM",
        //    "errorInfo": {}
        //}

        // see if it's trying to establish connection to 0'th partition of a hub
        // if so, it's not really an error. The hub wasn't created because no messages are flowing to it as of yet.
        if (rx_err.condition.indexOf('amqp:not-found') !== -1) {
            if (rx_err.description.indexOf('partitions/') !== -1) {
                Logger.debug(name, String.format('==> Did not find hub: {0}. Message: {1}', hub, rx_err.message));
            }
        } else {
            Logger.error(name, String.format('==> RX ERROR on hub: {0}, err: {1}', hub, rx_err));
        }

        if (!_.isUndefined(amqpClients[hub])) {
            amqpClients[hub].client.disconnect();
            delete amqpClients[hub];
        }
    };

    var ehMessageHandler = function (hub, myIdx, msg) {

        var annotations = msg.messageAnnotations;
        var newOffsetData = annotations['x-opt-offset'];

        var newOffset = Number(newOffsetData);

        var err;
        subs.checkPointHubPartition(err, name, hub, myIdx, newOffset);

        Logger.debug(name, String.format('==> Message Received on hub: {0} and partition: {1}. newOffset = {2}', hub, myIdx, newOffset));

        if (!_.isUndefined(this._quiescenceTimer)) {
            var d = new Date();
            Logger.debug(name, String.format('Resetting the timer at: {0}', d.toISOString()));
            clearTimeout(this._quiescenceTimer);
            this._quiescenceTimer = setTimeout(disconnectFunction, 5000);
        }

        var records = msg.body.records;
        if (!_.isUndefined(records)) {
            Logger.debug(name, String.format('message with {2} records received from hub {0} and partition {1}', hub, myIdx, records.length));

            records.forEach(function (record) {
                messageHandler(name, record, eventWriter);
            });

        } else {
            Logger.debug(name, String.format('ehMessageHandler received a message from event hub {0} and partition {1} with no records.', hub, myIdx));
            Logger.debug(name, JSON.stringify(msg));
        }

    };

    var createPartitionReceiver = function (hub, curIdx, curRcvAddr, filterOption) {
        Logger.debug(name, String.format('createPartitionReceiver for hub: {0} and partition: {1}', hub, curIdx));
        return amqpClients[hub].client.createReceiver(curRcvAddr, filterOption)
            .then(function (receiver) {
                receiver.on('message', ehMessageHandler.bind(null, hub, curIdx));
                receiver.on('errorReceived', ehErrorHandler.bind(null, hub, curIdx));
            })
            .catch(function (e) {
                Logger.error(name, String.format('create receiver error: {0}', e));
            });
    };

    function range(begin, end) {
        return Array.apply(null, new Array(end - begin)).map(function (_, i) { return i + begin; });
    }

    var disconnectFunction = function () {

        Logger.debug(name, 'Five seconds of silence on all hubs, disconnecting. This is normal - it means the hubs are drained.');
        var hubs = Object.keys(amqpClients);
        hubs.forEach(function (hub) {
            if (amqpClients[hub].connected === false) {
                Logger.error(name, String.format('No connection on hub: {0}. Is there a network route to the endpoint?', hub));
            }
            amqpClients[hub].client.disconnect();
            delete amqpClients[hub];
        });
        done();
    };

    var environment = subs.getEnvironment();
    var serviceBusHost = eventHubNamespace + environments[environment].serviceBusDns;
    subs.getEventHubCreds(SPNName, SPNPassword, SPNTenantID, vaultName, secretName, secretVersion)
        .then(function (creds) {

            var uri = 'amqps://' + encodeURIComponent(creds.sasKeyName) + ':' + encodeURIComponent(creds.sasKeyValue) + '@' + serviceBusHost;

            hubsToBeQueried.forEach(function (hub) {

                // make sure hub is initialized in checkpoints file
                var err;
                subs.checkPointHubPartition(err, name, hub);

                var filterOption = subs.getFilterOffsets(name, hub);
                var recvAddr = hub + '/ConsumerGroups/$default/Partitions/';

                amqpClients[hub] = {};
                amqpClients[hub].client = new AMQPClient(Policy.EventHub);
                amqpClients[hub].connected = false;

                amqpClients[hub].client.connect(uri)
                    .then(function () {
                        amqpClients[hub].connected = true;
                        return Promise.all([
                            Promise.map(range(0, 4), function (idx) {
                                return createPartitionReceiver(hub, idx, recvAddr + idx, filterOption[idx]);
                            })
                        ]);
                    })
                    .catch(function (e) {
                        Logger.error(name, String.format('connection error: {0}', e));
                    });
            });
        })
        .then(function () {
            var d = new Date();
            Logger.debug(name, String.format('Time is now: {0}', d.toISOString()));
            this._quiescenceTimer = setTimeout(disconnectFunction, 5000);
        })
        .catch(function (err) {
            Logger.error(name, String.format('Error getting event hub creds: {0}', err));
            return done();
        });
};
