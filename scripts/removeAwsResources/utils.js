const Lambda = require("aws-sdk/clients/lambda");
const ApiGateway = require("aws-sdk/clients/apigateway");
const CloudFront = require("aws-sdk/clients/cloudfront");
const IAM = require("aws-sdk/clients/iam");
const S3 = require("aws-sdk/clients/s3");
const CloudWatchLogs = require("aws-sdk/clients/cloudwatchlogs");
const { Observable } = require("rxjs");
const pRetry = require("p-retry");

const region = process.env.AWS_REGION || "us-east-1";
const lambda = new Lambda({ region });
const cloudWatchLogs = new CloudWatchLogs({ region });
const apiGateway = new ApiGateway({ region });
const cloudFront = new CloudFront({ region });
const iam = new IAM({ region });
const s3 = new S3({ region });

module.exports.getAllFunctions = async () => {
    const functions = [];

    let Marker = null;
    while (true) {
        const { Functions, NextMarker } = await lambda
            .listFunctions({ Marker, MaxItems: 10 })
            .promise();

        Functions.forEach(item => functions.push(item));

        if (!NextMarker) {
            break;
        }

        Marker = NextMarker;
    }

    return functions.sort((a, b) => {
        return new Date(b.LastModified).getTime() - new Date(a.LastModified).getTime();
    });
};

module.exports.getAllLogGroups = async () => {
    const groups = [];

    let Marker = null;
    while (true) {
        const { logGroups, nextToken } = await cloudWatchLogs
            .describeLogGroups({ logGroupNamePrefix: "/aws/", limit: 50, nextToken: Marker })
            .promise();

        logGroups.forEach(item => groups.push(item));

        if (!nextToken) {
            break;
        }

        Marker = nextToken;
    }

    return groups.sort((a, b) => {
        return new Date(b.creationTime).getTime() - new Date(a.creationTime).getTime();
    });
};

module.exports.getAllApiGateways = async () => {
    const gateways = [];

    let Marker = null;
    while (true) {
        const { items, position } = await apiGateway
            .getRestApis({ position: Marker, limit: 10 })
            .promise();

        items.forEach(item => gateways.push(item));

        if (!position) {
            break;
        }

        Marker = position;
    }

    return gateways.sort((a, b) => {
        return new Date(b.createdDate).getTime() - new Date(a.createdDate).getTime();
    });
};

module.exports.getAllBuckets = async () => {
    const { Buckets } = await s3.listBuckets({}).promise();

    return Buckets.sort((a, b) => {
        return new Date(b.CreationDate).getTime() - new Date(a.CreationDate).getTime();
    });
};

module.exports.getAllCloudFrontDistributions = async () => {
    const distributions = [];

    let Marker = null;
    while (true) {
        const { DistributionList } = await cloudFront
            .listDistributions({ Marker, MaxItems: "20" })
            .promise();

        const { IsTruncated, Items, NextMarker } = DistributionList;

        Items.forEach(item => distributions.push(item));

        if (!IsTruncated) {
            break;
        }

        Marker = NextMarker;
    }

    return distributions.sort((a, b) => {
        return new Date(b.LastModifiedTime).getTime() - new Date(a.LastModifiedTime).getTime();
    });
};

module.exports.getAllIAMRoles = async () => {
    const roles = [];

    let Marker = null;
    while (true) {
        const { Marker: NextMarker, IsTruncated, Roles } = await iam
            .listRoles({ Marker, MaxItems: 100 })
            .promise();

        Roles.forEach(item => roles.push(item));

        if (!IsTruncated) {
            break;
        }

        Marker = NextMarker;
    }

    return roles
        .filter(({ RoleName }) => {
            return (
                !RoleName.startsWith("AWSService") && !RoleName.startsWith("OrganizationAccount")
            );
        })
        .sort((a, b) => {
            return new Date(b.CreateDate).getTime() - new Date(a.CreateDate).getTime();
        });
};

module.exports.generateTasks = resources => {
    return Object.keys(resources)
        .map(type => {
            switch (type) {
                case "lambda":
                    return {
                        title: `Delete ${resources[type].length} Lambda functions`,
                        task: () => {
                            return new Observable(async observer => {
                                for (let i = 0; i < resources[type].length; i++) {
                                    const { FunctionName } = resources[type][i];
                                    observer.next(`Deleting ${FunctionName}...`);
                                    await lambda.deleteFunction({ FunctionName }).promise();
                                }

                                observer.complete();
                            });
                        }
                    };
                case "bucket":
                    return {
                        title: `Delete ${resources[type].length} buckets`,
                        task: () => {
                            return new Observable(async observer => {
                                for (let i = 0; i < resources[type].length; i++) {
                                    const { Name: Bucket } = resources[type][i];

                                    let Marker;
                                    while (true) {
                                        observer.next(`Emptying ${Bucket}...`);
                                        const { Contents, IsTruncated } = await s3
                                            .listObjects({ Bucket, Marker })
                                            .promise();

                                        if (!Contents.length) {
                                            break;
                                        }

                                        await s3
                                            .deleteObjects({
                                                Bucket,
                                                Delete: {
                                                    Objects: Contents.map(obj => ({ Key: obj.Key }))
                                                }
                                            })
                                            .promise();

                                        if (!IsTruncated) {
                                            break;
                                        }

                                        Marker = Contents[Contents.length - 1].Key;
                                    }

                                    observer.next(`Deleting ${Bucket}...`);
                                    await s3.deleteBucket({ Bucket }).promise();
                                }

                                observer.complete();
                            });
                        }
                    };
                case "api-gateway":
                    return {
                        title: `Delete ${resources[type].length} API Gateways`,
                        task: () => {
                            return new Observable(async observer => {
                                for (let i = 0; i < resources[type].length; i++) {
                                    const { name, id } = resources[type][i];

                                    observer.next(`Deleting ${name}...`);

                                    await pRetry(
                                        async () => {
                                            try {
                                                await apiGateway
                                                    .deleteRestApi({ restApiId: id })
                                                    .promise();
                                            } catch (error) {
                                                if (error.code !== "TooManyRequestsException") {
                                                    // Stop retrying and throw the error
                                                    throw new pRetry.AbortError(error);
                                                }
                                                observer.next(`${error.message}. Will retry...`);
                                                throw error;
                                            }
                                        },
                                        {
                                            retries: 3,
                                            minTimeout: 60000,
                                            factor: 2
                                        }
                                    );
                                }

                                observer.complete();
                            });
                        }
                    };
                case "iam-role":
                    return {
                        title: `Delete ${resources[type].length} IAM roles`,
                        task: () => {
                            return new Observable(async observer => {
                                for (let i = 0; i < resources[type].length; i++) {
                                    const { RoleName } = resources[type][i];

                                    observer.next(`Deleting ${RoleName}...`);

                                    const { PolicyNames } = await iam
                                        .listRolePolicies({ RoleName })
                                        .promise();

                                    for (let i = 0; i < PolicyNames.length; i++) {
                                        await iam
                                            .deleteRolePolicy({
                                                RoleName,
                                                PolicyName: PolicyNames[i]
                                            })
                                            .promise();
                                    }

                                    const {
                                        AttachedPolicies
                                    } = await iam.listAttachedRolePolicies({ RoleName }).promise();

                                    for (let i = 0; i < AttachedPolicies.length; i++) {
                                        await iam
                                            .detachRolePolicy({
                                                RoleName,
                                                PolicyArn: AttachedPolicies[i].PolicyArn
                                            })
                                            .promise();
                                    }

                                    await iam.deleteRole({ RoleName }).promise();
                                }

                                observer.complete();
                            });
                        }
                    };
                case "cloudfront":
                    return {
                        title: `Delete ${resources[type].length} CloudFront distribution`,
                        task: () => {
                            return new Observable(async observer => {
                                for (let i = 0; i < resources[type].length; i++) {
                                    const { Id, DomainName } = resources[type][i];

                                    observer.next(`Fetching ${DomainName} configuration...`);

                                    const {
                                        ETag,
                                        DistributionConfig
                                    } = await cloudFront.getDistributionConfig({ Id }).promise();

                                    if (DistributionConfig.Enabled) {
                                        observer.next(`Disabling ${DomainName}...`);
                                        await cloudFront
                                            .updateDistribution({
                                                Id,
                                                DistributionConfig: {
                                                    ...DistributionConfig,
                                                    Enabled: false
                                                },
                                                IfMatch: ETag
                                            })
                                            .promise();
                                        continue;
                                    }

                                    try {
                                        observer.next(`Deleting ${DomainName}...`);
                                        await cloudFront
                                            .deleteDistribution({ Id, IfMatch: ETag })
                                            .promise();
                                    } catch (err) {
                                        observer.error(err.message);
                                        return;
                                    }
                                }

                                observer.complete();
                            });
                        }
                    };
                case "log-group":
                    return {
                        title: `Delete ${resources[type].length} CloudWatch Log Groups`,
                        task: () => {
                            return new Observable(async observer => {
                                for (let i = 0; i < resources[type].length; i++) {
                                    const { logGroupName } = resources[type][i];
                                    observer.next(`Deleting ${logGroupName}...`);
                                    await cloudWatchLogs.deleteLogGroup({ logGroupName }).promise();
                                }

                                observer.complete();
                            });
                        }
                    };
                default:
                    return null;
            }
        })
        .filter(Boolean);
};
