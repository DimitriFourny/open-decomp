export const ENCODINGS = [
    {
        "instructionId": "ADDS_addsub_imm",
        "encodingId": "ADDS_32S_addsub_imm",
        "mnemonic": "ADDS",
        "className": "Setting the condition flags",
        "fileName": "adds_addsub_imm.xml",
        "mask": 4286578688,
        "value": 822083584,
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
        "instructionId": "ADDS_addsub_imm",
        "encodingId": "ADDS_64S_addsub_imm",
        "mnemonic": "ADDS",
        "className": "Setting the condition flags",
        "fileName": "adds_addsub_imm.xml",
        "mask": 4286578688,
        "value": 2969567232,
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
