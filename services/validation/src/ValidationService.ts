import bunyan from 'bunyan';
import Web3 from 'web3';
import { StringMap, SourceMap, PathBuffer, PathContent, CheckedContract, BufferMap } from '@ethereum-sourcify/core';
import AdmZip from 'adm-zip';
import fs from 'fs';
import Path from 'path';

/**
 * Regular expression matching metadata nested within another json.
 */
const NESTED_METADATA_REGEX = /"{\\"compiler\\":{\\"version\\".*?},\\"version\\":1}"/;

/**
 * Wraps the existing PathContent and adds a count variable
 * that keeps track of how many times the file was used.
 */
interface CountablePathContent {
    count: number;
    file: PathContent;
}

export interface IValidationService {
    /**
     * Checks all metadata files found in the provided paths. Paths may include regular files, directoris and zip archives.
     * 
     * @param paths The array of paths to be searched and checked.
     * @param ignoring Optional array where all unreadable paths can be stored.
     * @returns An array of CheckedContract objects.
     * @throws Error if no metadata files are found.
     */
    checkPaths(paths: string[], ignoring?: string[]): CheckedContract[];

    /**
     * Checks the files provided in the array of Buffers. May include buffers of zip archives.
     * Attempts to find all the resources specified in every metadata file found.
     * 
     * @param files The array of buffers to be checked.
     * @returns An array of CheckedContract objets.
     * @throws Error if no metadata files are found.
     */
    checkFiles(files: PathBuffer[] | BufferMap, unused?: PathContent[]): CheckedContract[];
}

export class ValidationService implements IValidationService {
    logger: bunyan;

    /**
     * @param logger a custom logger that logs all errors; undefined or no logger provided turns the logging off
     */
    constructor(logger?: bunyan) {
        this.logger = logger;
    }

    checkPaths(paths: string[], ignoring?: string[]): CheckedContract[] {
        const files: PathBuffer[] = [];
        paths.forEach(path => {
            if (fs.existsSync(path)) {
                this.traversePathRecursively(path, filePath => {
                    const fullPath = Path.resolve(filePath);
                    const file = {buffer: fs.readFileSync(filePath), path: fullPath};
                    files.push(file);
                });
            } else if (ignoring) {
                ignoring.push(path);
            }
        });

        return this.checkFiles(files);
    }

    checkFiles(files: PathBuffer[] | BufferMap, unused?: PathContent[]): CheckedContract[] {
        if (!Array.isArray(files)) { // ensure the type is an array of PathBuffers
            const arr: PathBuffer[] = [];
            for (const name in files) {
                arr.push({ path: name, buffer: files[name] });
            }
            files = arr;
        }

        const inputFiles = this.findInputFiles(files);
        const parsedFiles = inputFiles.map(pathBuffer => ({ content: pathBuffer.buffer.toString(), path: pathBuffer.path }));
        const { metadataFiles, otherFiles } = this.splitFiles(parsedFiles);

        const checkedContracts: CheckedContract[] = [];
        const errorMsgMaterial: string[] = [];

        const byHash = this.storeByHash(otherFiles);

        metadataFiles.forEach(metadata => {
            const { foundSources, missingSources, invalidSources } = this.rearrangeSources(metadata, byHash);
            const checkedContract = new CheckedContract(metadata, foundSources, missingSources, invalidSources);
            checkedContracts.push(checkedContract);
            if (!checkedContract.isValid()) {
                errorMsgMaterial.push(checkedContract.getInfo());
            }
        });

        if (errorMsgMaterial.length) {
            const msg = errorMsgMaterial.join("\n");
            if (this.logger) this.logger.error(msg);
        }

        if (unused) {
            this.extractUnused(byHash, unused);
        }

        return checkedContracts;
    }

    /**
     * Traverses the given files, unzipping any zip archive.
     * 
     * @param files the array containing the files to be checked
     * @returns an array containing the provided files, with any zips being unzipped and returned
     */
    private findInputFiles(files: PathBuffer[]): PathBuffer[] {
        const inputFiles: PathBuffer[] = [];
        for (const file of files) {
            if (this.isZip(file.buffer)) {
                this.unzip(file, files);
            } else {
                inputFiles.push(file);
            }
        }

        return inputFiles;
    }

    /**
     * Checks whether the provided file is in fact zipped.
     * @param file the buffered file to be checked
     * @returns true if the file is zipped; false otherwise
     */
    private isZip(file: Buffer): boolean {
        try {
            new AdmZip(file);
            return true;
        } catch (err) { undefined }
        return false;
    }

    /**
     * Unzips the provided file buffer to the provided array.
     * 
     * @param zippedFile the buffer containin the zipped file to be unpacked
     * @param files the array to be filled with the content of the zip
     */
    private unzip(zippedFile: PathBuffer, files: PathBuffer[]): void {
        const timestamp = Date.now().toString();
        const tmpDir = `tmp-unzipped-${timestamp}`;

        new AdmZip(zippedFile.buffer).extractAllTo(tmpDir);

        this.traversePathRecursively(tmpDir, filePath => {
            const file = {buffer: fs.readFileSync(filePath), content: zippedFile.path};
            files.push(file);
        });
        this.traversePathRecursively(tmpDir, fs.unlinkSync, fs.rmdirSync);
    }

    /**
     * Selects metadata files from an array of files that may include sources, etc
     * @param  {string[]} files
     * @return {string[]}         metadata
     */
    private splitFiles(files: PathContent[]): { metadataFiles: any[], otherFiles: PathContent[] } {
        const metadataFiles = [];
        const otherFiles: PathContent[] = [];
        const malformedMetadataFiles = [];

        for (const file of files) {
            let metadata = this.extractMetadataFromString(file.content);
            if (!metadata) {
                const matchRes = file.content.match(NESTED_METADATA_REGEX);
                if (matchRes) {
                    metadata = this.extractMetadataFromString(matchRes[0]);
                }
            }

            if (metadata) {
                try {
                    this.assertObjectSize(metadata.settings.compilationTarget, 1);
                    metadataFiles.push(metadata);
                } catch (err) {
                    malformedMetadataFiles.push(file.path);
                }
            } else {
                otherFiles.push(file);
            }
        }

        let msg = "";
        if (malformedMetadataFiles.length) {
            const responsibleFiles =
                malformedMetadataFiles.every(Boolean) ?
                malformedMetadataFiles.join(", ") : `${malformedMetadataFiles.length} metadata files`;
            msg = `Malformed settings.compilationTarget in: ${responsibleFiles}`;

        } else if (!metadataFiles.length) {
            msg = "Metadata file not found. Did you include \"metadata.json\"?";
        }

        if (msg) {
            if (this.logger) this.logger.error(msg);
            throw new Error(msg);
        }

        return { metadataFiles, otherFiles };
    }

    /**
     * Validates metadata content keccak hashes for all files and
     * returns mapping of file contents by file name
     * @param  {any}       metadata
     * @param  {Map<string, any>}  byHash    Map from keccak to source
     * @return foundSources, missingSources, invalidSources
     */
    private rearrangeSources(metadata: any, byHash: Map<string, CountablePathContent>) {
        const foundSources: SourceMap = {};
        const missingSources: any = {};
        const invalidSources: StringMap = {};

        for (const fileName in metadata.sources) {
            const sourceInfo = metadata.sources[fileName];
            let file: PathContent = { content: undefined };
            file.content = sourceInfo.content;
            const hash: string = sourceInfo.keccak256;
            if (file.content) {
                if (Web3.utils.keccak256(file.content) != hash) {
                    const msg = "The calculated and the provided hash values don't match.";
                    invalidSources[fileName] = msg;
                    continue;
                }
            } else {
                const countablePathContent = byHash.get(hash);
                if (countablePathContent) {
                    file = countablePathContent.file;
                    countablePathContent.count++;
                } // else: no file has the hash that was searched for
            }

            if (file && file.content) {
                foundSources[fileName] = file;
            } else {
                missingSources[fileName] = { keccak256: hash, urls: sourceInfo.urls };
            }
        }

        return { foundSources, missingSources, invalidSources };
    }

    /**
     * Generates a map of files indexed by the keccak hash of their content.
     * 
     * @param  {string[]}  files Array containing sources.
     * @returns Map object that maps hash to PathContent.
     */
    private storeByHash(files: PathContent[]): Map<string, CountablePathContent> {
        const byHash: Map<string, CountablePathContent> = new Map();

        for (const i in files) {
            const calculatedHash = Web3.utils.keccak256(files[i].content);
            byHash.set(calculatedHash, { count: 0, file: files[i] });
        }
        return byHash;
    }

    private extractUnused(byHash: Map<string, CountablePathContent>, unused: PathContent[]): void {
        for (const [, countablePathContent] of byHash) {
            const { file, count } = countablePathContent;
            if (count === 0) {
                unused.push(file);
            }
        }
    }

    private extractMetadataFromString(file: string): any {
        try {
            let obj = JSON.parse(file);
            if (this.isMetadata(obj)) {
                return obj;
            }

            // if the input string originates from a file where it was double encoded (e.g. truffle)
            obj = JSON.parse(obj);
            if (this.isMetadata(obj)) {
                return obj;
            }
        } catch (err) { undefined }

        return null;
    }

    /**
     * A method that checks if the provided object was generated as a metadata file of a Solidity contract.
     * Current implementation is rather simplistic and may require further engineering.
     * 
     * @param metadata the JSON to be checked
     * @returns true if the provided object is a Solidity metadata file; false otherwise
     */
    private isMetadata(obj: any): boolean {
        return  (obj.language === "Solidity") &&
                !!obj.compiler;
    }

    /**
     * Applies the provided worker function to the provided path recursively.
     * 
     * @param path the path to be traversed
     * @param worker the function to be applied on each file that is not a directory
     * @param afterDir the function to be applied on the directory after traversing its children
     */
    private traversePathRecursively(path: string, worker: (filePath: string) => void, afterDirectory?: (filePath: string) => void) {
        if (!fs.existsSync(path)) {
            const msg = `Encountered a nonexistent path: ${path}`;
            if (this.logger) {this.logger.error(msg);}
            throw new Error(msg);
        }

        const fileStat = fs.lstatSync(path);
        if (fileStat.isFile()) {
            worker(path);
        } else if (fileStat.isDirectory()) {
            fs.readdirSync(path).forEach(nestedName => {
                const nestedPath = Path.join(path, nestedName);
                this.traversePathRecursively(nestedPath, worker, afterDirectory);
            });
    
            if (afterDirectory) {
                afterDirectory(path);
            }
        }
    }


    /**
     * Asserts that the number of keys of the provided object is expectedSize.
     * If not, logs an appropriate message (if log function provided) and throws an Error.
     * @param object the object to check
     * @param expectedSize the size that the object should have
     */
    private assertObjectSize(object: any, expectedSize: number) {
        let err = "";
        
        if (!object) {
            err = `Cannot assert for ${object}.`;
        } else {
            const objectSize = Object.keys(object).length;   
            if (objectSize !== expectedSize) {
                err = `Error in size assertion! Actual size: ${objectSize}. Expected size: ${expectedSize}.`;
            }
        }

        if (err) {
            if (this.logger) {
                this.logger.error({ loc: "[VALIDATION:SIZE_ASSERTION]" }, err);
            }
            throw new Error(err);
        }
    }
}