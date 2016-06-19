import * as _ from "lodash";
import {MemoryBlock} from "../emulation/memory-block";
import {ClearCarry} from "../emulation/instruction/flags";
import {SetCarry} from "../emulation/instruction/flags";
import {SetDirection} from "../emulation/instruction/flags";
import {ClearDirection} from "../emulation/instruction/flags";
import {LineMap} from "./program";
import {Program} from "./program";
import {EncodedInstruction} from "./encoding";
import {Parameter} from "../emulation/instruction/parameter";
import {Move} from "../emulation/instruction/mov";
import {Instruction} from "../emulation/instruction/instruction";
import {RegisterParameter} from "../emulation/instruction/parameter";
import {ConstantParameter} from "../emulation/instruction/parameter";
import {REGISTER_INDEX} from "../emulation/cpu";
import {MemoryParameter} from "../emulation/instruction/parameter";
import {Jump} from "../emulation/instruction/jump";
import {LabelParameter} from "../emulation/instruction/parameter";
import {Interrupt} from "../emulation/instruction/interrupt";
var parser = require("./asm-parser.js");

class Label
{
    constructor(public name: string, public local: boolean, public address: number)
    {

    }
}

class LabelResolver
{
    private labels: any = {};
    private unresolvedParameters: LabelParameter[] = [];

    addLabel(address: number, label: string, local: boolean = false)
    {
        label = this.normalizeLabelName(label, local, address);

        if (this.hasLabel(label))
        {
            throw new AssemblyException("Duplicate label found: " + label);
        }

        this.labels[label] = new Label(label, local, address);
    }
    private normalizeLabelName(label: string, local: boolean, address: number): string
    {
        if (local)
        {
            let previousLabel: Label = this.findPreviousGlobalLabel(address);

            if (previousLabel === undefined)
            {
                throw new AssemblyException("Local label without a global label: " + label);
            }

            return previousLabel.name + "." + label;
        }

        return label;
    }
    private hasLabel(label: string): boolean
    {
        return _.has(this.labels, label);
    }
    private findPreviousGlobalLabel(address: number): Label
    {
        return _.findLast(this.labels, (label: Label) => !label.local && label.address <= address);
    }

    markUnresolvedParameter(labelParameter: LabelParameter)
    {
        this.unresolvedParameters.push(labelParameter);
    }
    resolveAddresses()
    {
        _.each(this.unresolvedParameters, (labelParameter: LabelParameter) => {
            if (!_.has(this.labels, labelParameter.label))
            {
                throw new AssemblyException("Unknown label " + labelParameter.label);
            }

            labelParameter.resolveLabel(this.labels[labelParameter.label].address);
        });
    }
}

export class AssemblyException
{
    constructor(public message: string = "",
                public line: number = 0,
                public data: any = {})
    {

    }
}

const InstructionMapping = {
    "MOV": Move,
    "JMP": Jump,
    "INT": Interrupt
};

enum MemoryType
{
    Data = 0,
    Text = 1
}

class AssemblyData
{
    constructor(public textAddress: number = 0,
                public dataAddress: number = 0,
                public lineMap: LineMap = new LineMap(),
                public labelResolver: LabelResolver = new LabelResolver())
    {

    }

    public getAddress(memoryType: MemoryType): number
    {
        return memoryType === MemoryType.Data ? this.dataAddress : this.textAddress;
    }
}

export class MemoryDefinition
{
    constructor(private _address: number,
                private _size: number,
                private _value: any)
    {

    }

    get address(): number
    {
        return this._address;
    }
    get size(): number
    {
        return this._size;
    }
    get value(): any
    {
        return this._value;
    }
}

// TODO: comment on empty lines
export class Assembler
{
    assemble(program: string) : Program
    {
        let parsedProgram: {text: any[], data: any[]};

        try
        {
            parsedProgram = parser.parse(program);
        }
        catch (e)
        {
            throw new AssemblyException(e.message, e.location.start.line);
        }

        let assemblyData: AssemblyData = new AssemblyData();
        let memoryDefinitions: MemoryDefinition[] = this.assembleDataSegment(parsedProgram.data, assemblyData);
        let instructions: EncodedInstruction[] = this.assembleTextSegment(parsedProgram.text, assemblyData);

        assemblyData.labelResolver.resolveAddresses();

        return new Program(instructions, memoryDefinitions, assemblyData.lineMap);
    }

    private assembleDataSegment(dataLines: any[], assemblyData: AssemblyData): MemoryDefinition[]
    {
        let memoryDefinitions: MemoryDefinition[] = [];

        for (let i = 0; i < dataLines.length; i++)
        {
            let line: number = dataLines[i].location.start.line - 1;
            try
            {
                memoryDefinitions = memoryDefinitions.concat(this.assembleMemoryDefinitions(dataLines[i].line, assemblyData));
            }
            catch (e)
            {
                if (e instanceof AssemblyException)
                {
                    throw new AssemblyException(e.message, line + 1, dataLines[i].line);
                }
                else throw e;
            }
        }

        return memoryDefinitions;
    }
    private assembleMemoryDefinitions(line: any, assemblyData: AssemblyData): MemoryDefinition[]
    {
        if (line.label !== null)
        {
            this.assembleLabel(line.label, assemblyData, MemoryType.Data);
        }


        let definitions: MemoryDefinition[] = [];
        let size: number = line.size;
        if (size !== null)
        {
            for (let i = 0; i < line.constants.length; i++)
            {
                let constant = line.constants[i];

                if (constant.tag === "String")
                {
                    let characters: string[] = <string[]>(constant.value);
                    for (let j = 0; j < characters.length; j++)
                    {
                        definitions.push(new MemoryDefinition(assemblyData.dataAddress, size, characters[j].charCodeAt(0)));
                        assemblyData.dataAddress += size;
                    }
                }
                else if (constant.tag === "Number")
                {
                    definitions.push(new MemoryDefinition(assemblyData.dataAddress, size, constant.value));
                    assemblyData.dataAddress += size;
                }
            }
        }

        return definitions;
    }

    private assembleTextSegment(textLines: any[], assemblyData: AssemblyData): EncodedInstruction[]
    {
        let instructions: EncodedInstruction[] = [];

        for (let i = 0; i < textLines.length; i++)
        {
            let line: number = textLines[i].location.start.line - 1;
            try
            {
                let instruction: EncodedInstruction = this.assembleInstruction(textLines[i].line, assemblyData);
                if (instruction !== null)
                {
                    instructions.push(instruction);
                    assemblyData.lineMap.mapLine(assemblyData.textAddress, line);
                    assemblyData.textAddress++;
                }
            }
            catch (e)
            {
                if (e instanceof AssemblyException)
                {
                    throw new AssemblyException(e.message, line + 1, textLines[i].line);
                }
                else throw e;
            }
        }

        return instructions;
    }

    private assembleInstruction(line: {tag: string, label: any, instruction: any}, assemblyData: AssemblyData): EncodedInstruction
    {
        if (line.label !== null)
        {
            this.assembleLabel(line.label, assemblyData, MemoryType.Text);
        }

        if (line.instruction !== null)
        {
            return this.parseInstruction(line.instruction);
        }
        else return null;
    }
    private parseInstruction(instruction: {tag: string, type: string, name: string, operands: any[]}): EncodedInstruction
    {
        if (!_.has(InstructionMapping, instruction.name))
        {
            throw new AssemblyException("Unknown instruction type " + instruction.type);
        }

        let instructionInstance: Instruction = new InstructionMapping[instruction.name];
        return new EncodedInstruction(instructionInstance, this.loadParameters(instructionInstance, instruction.operands));
    }

    private loadParameters(instruction: Instruction, operands: any[]): Parameter[]
    {
        this.checkParameterCompatibility(instruction, operands);

        let mapping = {};
        mapping[Parameter.Reg] = this.parseRegisterParameter;
        mapping[Parameter.Constant] = this.parseConstantParameter;
        mapping[Parameter.Memory] = this.parseMemoryParameter;
        mapping[Parameter.Label] = this.parseLabelParameter;

        return _.map(operands, (operand) => {
            let innerOperand: any = this.getInnerParameter(operand);
            return mapping[innerOperand.tag].call(this, this.getParameterSize(operand), innerOperand);
        });
    }
    private parseRegisterParameter(size: number, operand: any): Parameter
    {
        return new RegisterParameter(size, REGISTER_INDEX[this.parseRegisterName(operand)].id);
    }
    private parseConstantParameter(size: number, operand: any): Parameter
    {
        return new ConstantParameter(size, operand.value, _.has(operand, "deref"));
    }
    private parseMemoryParameter(size: number, operand: any): Parameter
    {
        let baseRegId: number = REGISTER_INDEX[this.parseRegisterName(operand.baseRegister)].id;

        let indexRegId: number = 0;
        if (operand.indexRegister !== null)
        {
            indexRegId = REGISTER_INDEX[this.parseRegisterName(operand.indexRegister)].id;
        }

        let multiplier: number = operand.multiplier !== null ? operand.multiplier.value : 0;
        let constant: number = operand.constant !== null ? operand.constant.value : 0;

        return new MemoryParameter(size, baseRegId, indexRegId, multiplier, constant);
    }
    private parseLabelParameter(size: number, operand: any, assemblyData: AssemblyData): Parameter
    {
        let labelParameter: LabelParameter = new LabelParameter(size, operand.value, _.has(operand, "deref"));
        assemblyData.labelResolver.markUnresolvedParameter(labelParameter);

        return labelParameter;
    }

    private parseRegisterName(operand: any): string
    {
        let registerName: string = operand.name;
        if (!_.has(REGISTER_INDEX, registerName)) throw new AssemblyException("Unknown register " + registerName);

        return registerName;
    }
    private checkParameterCompatibility(instruction: Instruction, operands: any[])
    {
        let parameterMask = _.map(operands, (operand) => this.getInnerParameter(operand).tag);
        let validMasks: string[][] = instruction.getValidParameters();

        for (let i = 0; i < validMasks.length; i++)
        {
            if (_.isEqual(parameterMask, validMasks[i]))
            {
                return;
            }
        }

        throw new AssemblyException("Unknown parameter combination for instruction " + instruction.toString());
    }
    private getInnerParameter(operand: any): any
    {
        if (operand.tag === "Cast") return this.getInnerParameter(operand.value);
        else return operand;
    }
    private getParameterSize(operand: any): number
    {
        if (operand.tag === "Cast") return operand.size > 0 ? operand.size : 4;
        else return 4;
    }

    private assembleLabel(label: {tag: string, name: any, local: boolean}, assemblyData: AssemblyData, memoryType: MemoryType)
    {
        assemblyData.labelResolver.addLabel(assemblyData.getAddress(memoryType), label.name.value, label.local);
    }
}