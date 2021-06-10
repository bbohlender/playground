import { KaggleApi } from "../api/kaggle"
import { KaggleKernelPushRequest } from "../api/kaggle/models/KaggleKernelPushRequest"
import { Task, TaskStatus, TaskOutput } from "../entities"
import { ComputationService } from "./computation-service"
import axios from "axios"
import { v4 as uuidv4 } from "uuid"
import { ReadStream } from "fs"
import { FileUpload } from "graphql-upload"
import { KaggleKernelOutputFile } from "../api/kaggle/models/KaggleKernelOutputFile"

const authenticationCache = new Map<string, number>()

export class KaggleComputationService implements ComputationService {
    async checkAuthentication(credentials: any): Promise<boolean> {
        const authenticationDate = authenticationCache.get(credentials.username)
        if (authenticationDate != null) {
            //15 minutes expire time
            if (new Date().getTime() - authenticationDate <= 15 * 60 * 1000) {
                return true
            }
        }
        // send random status request and see if response is: 401 unauthorized
        try {
            await KaggleApi.kernelStatus(credentials, credentials.username, "183z2u3h")
        } catch (error) {
            if (error.response.status === 401) {
                return false
            } else if (error.response.status === 404) {
                //kernel "test" does not exist but user is authenticated
                authenticationCache.set(credentials.username, new Date().getTime())
                return true
            } else {
                throw error
            }
        }
        return true
    }

    async getTaskStatus(credentials: any, task: Task): Promise<TaskStatus> {
        const response = await KaggleApi.kernelStatus(credentials, credentials.username, task.kernelId!)
        switch (response.status) {
            case "complete":
                return TaskStatus.Complete
            case "error":
                return TaskStatus.Error
            case "queued":
                return TaskStatus.Queued
            case "running":
                return TaskStatus.Running
        }
    }

    async getTaskOutput(credentials: any, task: Task): Promise<TaskOutput | undefined> {
        const { files, log } = await KaggleApi.kernelOutput(credentials, credentials.username, task.kernelId!)
        return {
            ...(await this.getMetrics(files)),
            files:
                files?.map((file) => ({
                    name: file.fileName,
                    url: file.url,
                })) ?? [],
            log: Array.isArray(log)
                ? log.map(({ data, stream_name, time }) => `[${stream_name}]@${time}: ${data}`).join(",")
                : "",
            error: await this.getError(files),
        }
    }

    private async getMetrics(
        files: Array<KaggleKernelOutputFile>
    ): Promise<{ f1: number | undefined; accuracy: number | undefined } | undefined> {
        const metadataFile = files.find((file) => file.fileName.endsWith("metadata.txt"))
        if (metadataFile == null) {
            return undefined
        }
        const metadataContent = (await axios.get(metadataFile.url)).data
        if (typeof metadataContent != "string") {
            throw "metadata.txt not string content"
        }
        const [sheetsLink, accuracy, f1] = metadataContent.split("\n")
        return { f1: tryParseFloat(f1), accuracy: tryParseFloat(accuracy) }
    }

    private async getError(files: Array<KaggleKernelOutputFile>): Promise<string | undefined> {
        const errorFile = files.find((file) => file.fileName.endsWith("error.txt"))
        if (errorFile == null) {
            return
        }
        const errorContent = (await axios.get(errorFile.url)).data

        if (typeof errorContent != "string") {
            return undefined
        }

        return errorContent
    }

    async startTask(credentials: any, task: Task, code: string, filePath: string | undefined): Promise<void> {
        if (task.kernelId == null) {
            throw "task has no kernel id (not created for kaggle?)"
        }
        const kernelPushRequest = new KaggleKernelPushRequest(
            credentials.username,
            task.kernelId,
            code,
            "python",
            "script"
        )
        kernelPushRequest.setIsPrivate(true)
        kernelPushRequest.setEnableGpu(true)
        kernelPushRequest.setEnableInternet(true)
        kernelPushRequest.setDockerImagePinningType("original")

        if (filePath != null) {
            kernelPushRequest.setDatasetDataSources([filePath])
        }

        const { error } = await KaggleApi.kernelPush(credentials, kernelPushRequest)
        if (error != null) {
            throw error
        }
    }

    private streamToBuffer(stream: ReadStream) {
        return new Promise<Buffer>((resolve, reject) => {
            const buffers: Array<Buffer> = []
            stream.on("data", (data) => buffers.push(Buffer.isBuffer(data) ? data : Buffer.from(data, "utf8")))
            stream.on("end", () => resolve(Buffer.concat(buffers)))
            stream.on("error", reject)
        })
    }

    async uploadFile(credentials: any, file: FileUpload): Promise<string> {
        const buffer = await this.streamToBuffer(file.createReadStream())

        const { token, createUrl } = await KaggleApi.uploadFile(credentials, "default", buffer.length, 0)
        await axios.post(createUrl, buffer)

        const filePath = await KaggleApi.createDataset(credentials, credentials.username, uuidv4(), token)

        await wait(3000)

        return filePath
    }
}

function wait(millis: number) {
    return new Promise((resolve) => setTimeout(resolve, millis))
}

function tryParseFloat(val: string): number | undefined {
    const result = parseFloat(val)
    return isNaN(result) ? undefined : result
}
