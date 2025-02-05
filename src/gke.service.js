const container = require('@google-cloud/container');
const { JWT } = require('google-auth-library');
const {removeUndefinedAndEmpty, sleep} = require('./helpers');
const parsers = require("./parsers");
const GCCEService = require('./gcce.service');
const { google } = require('googleapis');
const containerApi = google.container('v1');

module.exports = class GKEService{
    constructor({credentials, projectId}){
        if (!credentials) throw "Must provide credentials and project!";
        if (typeof credentials !== "object") throw "Credentials provided in a bad format";
        this.options = {credentials};
        if (projectId) this.options.projectId = projectId;
        try {
            this.gcce = new GCCEService(credentials, projectId);
            this.gke = new container.v1.ClusterManagerClient(this.options);
        }
        catch (e) {
            throw `Couldn't connect to Google Cloud: ${e.message || e}`;
        }
    }

    static from(params, settings){
        return new GKEService({
            credentials: parsers.jsonString(params.creds || settings.creds),
            projectId: parsers.autocomplete(params.project || settings.project)
        });
    }
    
    getAuthClient(){
        return new JWT(
            this.options.credentials.client_email, null,
            this.options.credentials.private_key,
            ['https://www.googleapis.com/auth/cloud-platform']
        );
    }

    async createBasicCluster(params){
        const {name:clusterName, locationType, region, zone, controlPlaneReleaseChannel, version, waitForOperation} = params;
        const isZonal = locationType === "Zonal";
        if (!clusterName || !locationType || !version || (isZonal && !zone) || (!isZonal && !region)){
            throw "Didn't provide one of the required parameters!";
        }
        return this.createClusterJson({
            clusterJson: removeUndefinedAndEmpty({
                "name": clusterName, 
                "location": isZonal ? zone : region,
                "locations": isZonal ? [zone] : undefined,
                "releaseChannel": controlPlaneReleaseChannel === "none" ? undefined : {
                    "channel": controlPlaneReleaseChannel
                },
                "initialClusterVersion": version,
                "nodePools": [GKEService.parseNodePool({
                    nodePoolName: 'default-pool',
                    ...params
                })],
            }),
            zone, region, locationType, waitForOperation
        });
    }

    static parseNodePool({nodePoolName, numberOfNodes, enableAutoscaling, minNode, maxNode, maxSurge, maxUnavailable, machineType, customMachineCpuCount, customMachineMem, nodeImage, 
        diskType, diskSize, diskEncryptionKey, preemptible, maxPodsPerNode, networkTags, serviceAccount, saAccessScopes, enableIntegrityMonitoring, enableSecureBoot, labels, gceInstanceMetadata, version}){
        if (customMachineCpuCount || customMachineMem){
            machineType += `-${customMachineCpuCount}-${customMachineMem}`;
        }
        if (!nodePoolName || !numberOfNodes || !machineType || !diskType || !diskSize){
            throw "Didn't provide one of the required parameters."
        }
        return removeUndefinedAndEmpty({
            "name": nodePoolName,
            "initialNodeCount": numberOfNodes,
            "autoscaling": enableAutoscaling ? {
                "enabled": true, 
                "maxNodeCount": maxNode,
                "minNodeCount": minNode
            } : {},
            "maxPodsConstraint": {
                "maxPodsPerNode": String(maxPodsPerNode || 110)
            },
            "upgradeSettings": { maxSurge, maxUnavailable },
            "config": {
                "diskSizeGb": diskSize,
                "metadata": {
                    ...(gceInstanceMetadata || {}),
                    "disable-legacy-endpoints": "true"    
                } ,
                "imageType": nodeImage,
                "tags": networkTags,
                "bootDiskKmsKey": diskEncryptionKey,
                "shieldedInstanceConfig": { 
                    "enableSecureBoot": enableSecureBoot, 
                    "enableIntegrityMonitoring": enableIntegrityMonitoring
                },
                "oauthScopes": saAccessScopes === "full" ? ["https://www.googleapis.com/auth/cloud-platform"] : 
                [
                    "https://www.googleapis.com/auth/devstorage.read_only",
                    "https://www.googleapis.com/auth/logging.write",
                    "https://www.googleapis.com/auth/monitoring",
                    "https://www.googleapis.com/auth/servicecontrol",
                    "https://www.googleapis.com/auth/service.management.readonly",
                    "https://www.googleapis.com/auth/trace.append"
                ],
                "management": {
                    "autoUpgrade": true,
                    "autoRepair": true
                },
                "serviceAccount": serviceAccount, 
                "machineType": machineType, 
                "labels": labels, 
                "diskType": diskType, 
                "preemptible": preemptible
            },
            "version": version
        });
    }
    
    async createClusterJson({locationType, region, zone, clusterJson, waitForOperation}){
        if (!clusterJson) throw "Didn't provide cluster parameters JSON!";
        const isZonal = locationType === "Zonal";
        const operation = (await this.gke.createCluster({
            parent: this.getLocationAsParent({region, zone: isZonal ? zone : undefined}),
            cluster: clusterJson,
            zone: isZonal ? zone : undefined
        }))[0];
        return waitForOperation ? this.waitForOperation({
            zone: isZonal ? zone : undefined,
            region, operation
        }) : operation;
    }
    
    async createNodePool(params){
        const {cluster, region, zone, waitForOperation} = params;
        return this.createNodePoolJson({
            cluster, region, zone, waitForOperation,
            nodePoolJson: GKEService.parseNodePool(params)
        })
    }
    
    async createNodePoolJson({region, zone, cluster, nodePoolJson, waitForOperation}){
        if (!cluster) {
            throw "Must provide a cluster to create the node pool for.";
        }
        if (!nodePoolJson) throw "Didn't provide Node Pool parameters JSON!";
        const parent = this.getClusterAsParent({region, zone, cluster});
        const operation = (await this.gke.createNodePool({
            clusterId: cluster,
            nodePool: nodePoolJson,
            parent, zone
        }))[0];
        return waitForOperation ? this.waitForOperation({zone, region, operation}) : operation;
    }
    
    async deleteCluster({region, zone, cluster, waitForOperation}){
        if (!cluster) {
            throw "Must provide a cluster to delete.";
        }
        const parent = this.getLocationAsParent({region, zone});
        const operation = (await  this.gke.deleteCluster({
            clusterId: cluster,
            projectId: this.options.projectId,
            parent, zone
        }))[0];
        return waitForOperation ? this.waitForOperation({zone, region, operation}) : operation;
    }
    
    async deleteNodePool({region, zone, cluster, nodePool, waitForOperation}){
        if (!cluster || !nodePool) {
            throw "Didn't provide one of the required parameters.";
        }
        const parent = this.getClusterAsParent({region, zone, cluster});
        const operation = (await  this.gke.deleteNodePool({
            clusterId: cluster,
            nodePoolId: nodePool,
            projectId: this.options.projectId,
            parent, zone
        }))[0];
        return waitForOperation ? this.waitForOperation({zone, region, operation}) : operation;
    }
    
    async describeCluster({region, zone, cluster}){
        if (!cluster) {
            throw "Must provide a cluster to describe.";
        }
        const parent = this.getClusterAsParent({region, zone, cluster});
        return (await this.gke.getCluster({
            clusterId: cluster,
            projectId: this.options.projectId,
            parent, zone
        }))[0];
    }
    
    getClusterAsParent({region, zone, cluster: clusterId}) {
        return `${this.getLocationAsParent({region, zone})}/clusters/${clusterId}`;
    }
    getLocationAsParent({region, zone}) {
        return `projects/${this.options.projectId}/${zone ? "zones" : "locations"}/${zone || region}`;
    }
    
    async listClusters({region, zone}){
        const parent = this.getLocationAsParent({region, zone});
        return (await this.gke.listClusters({parent, zone}))[0].clusters;
    }
    
    async listNodePools({region, zone, cluster}){
        if (!cluster) {
            throw "Must provide a cluster to list it's node pools.";
        }
        const parent = this.getClusterAsParent({region, zone, cluster});
        return (await this.gke.listNodePools({clusterId: cluster, parent, zone}))[0].nodePools;
    }
    
    async listProjects({query}){
        return this.gcce.listProjects({query});
    }
    
    async listRegions({}, fields){
        return this.gcce.listRegions({}, fields);
    }
    
    async listZones({region}, fields){
        return this.gcce.listZones({region}, fields);
    }
    
    async listMachineTypes({zone}, fields, pageToken){
        if (!zone) zone = "us-central1-c";
        return this.gcce.listMachineTypes({zone}, fields, pageToken);
    }
    
    async listServiceAccounts(){
        return this.gcce.listServiceAccounts({});
    }

    async waitForOperation({region, zone, operation}){
        const params = {
            auth: this.getAuthClient(),
            projectId: this.options.projectId, 
            name: `${this.getLocationAsParent({region, zone})}/operations/${operation.name}`,
            operationId: operation.name
        };
        while (operation.status !== "DONE" && operation.status !== "ABORTING"){
            try {
                if (zone) operation = (await containerApi.projects.zones.operations.get({...params, zone})).data;
                else operation = (await containerApi.projects.locations.operations.get(params)).data;
            } catch (e) {
                throw "Couldn't get operation: " + e.message  + "\n"+ JSON.stringify(operation);
            }
            await sleep(2000); // sleep for 2 seconds
        }
        if (operation.status === "DONE" && !operation.error) return operation;
        throw operation;
    }
}