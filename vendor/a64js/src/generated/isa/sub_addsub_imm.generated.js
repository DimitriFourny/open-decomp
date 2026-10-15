export const ENCODINGS = [
    {
        "instructionId": "SUB_addsub_imm",
        "encodingId": "SUB_32_addsub_imm",
        "mnemonic": "SUB",
        "className": "Not setting the condition flags",
        "fileName": "sub_addsub_imm.xml",
        "mask": 4286578688,
        "value": 1358954496,
        "bitCount": 9,
        "fields": [
            {
                "name": "sf",
                "lsb": 31,
                "width": 1
            },
            {
                "name": "op",
                "lsb": 30,
                "width": 1
            },
            {
                "name": "S",
                "lsb": 29,
                "width": 1
            },
            {
                "name": "sh",
                "lsb": 22,
                "width": 1
            },
            {
                "name": "imm12",
                "lsb": 10,
                "width": 12
            },
            {
                "name": "Rn",
                "lsb": 5,
                "width": 5
            },
            {
                "name": "Rd",
                "lsb": 0,
                "width": 5
            }
        ],
        "features": [],
        "featureGuards": [],
        "guards": [],
        "operandFamilyId": "add-sub-immediate"
    },
    {
        "instructionId": "SUB_addsub_imm",
        "encodingId": "SUB_64_addsub_imm",
        "mnemonic": "SUB",
        "className": "Not setting the condition flags",
        "fileName": "sub_addsub_imm.xml",
        "mask": 4286578688,
        "value": 3506438144,
        "bitCount": 9,
        "fields": [
            {
                "name": "sf",
                "lsb": 31,
                "width": 1
            },
            {
                "name": "op",
                "lsb": 30,
                "width": 1
            },
            {
                "name": "S",
                "lsb": 29,
                "width": 1
            },
            {
                "name": "sh",
                "lsb": 22,
                "width": 1
            },
            {
                "name": "imm12",
                "lsb": 10,
                "width": 12
            },
            {
                "name": "Rn",
                "lsb": 5,
                "width": 5
            },
            {
                "name": "Rd",
                "lsb": 0,
                "width": 5
            }
        ],
        "features": [],
        "featureGuards": [],
        "guards": [],
        "operandFamilyId": "add-sub-immediate"
    }
];
