export const ENCODINGS = [
    {
        "instructionId": "bfmla_z_zzzi",
        "encodingId": "bfmla_z_zzzi_h",
        "mnemonic": "BFMLA",
        "className": "SVE2",
        "fileName": "bfmla_z_zzzi.xml",
        "mask": 4288740352,
        "value": 1679820800,
        "bitCount": 16,
        "fields": [
            {
                "name": "i3h",
                "lsb": 22,
                "width": 1
            },
            {
                "name": "i3l",
                "lsb": 19,
                "width": 2
            },
            {
                "name": "Zm",
                "lsb": 16,
                "width": 3
            },
            {
                "name": "o2",
                "lsb": 11,
                "width": 1
            },
            {
                "name": "op",
                "lsb": 10,
                "width": 1
            },
            {
                "name": "Zn",
                "lsb": 5,
                "width": 5
            },
            {
                "name": "Zda",
                "lsb": 0,
                "width": 5
            }
        ],
        "features": [
            "FEAT_SVE_B16B16"
        ],
        "featureGuards": [],
        "guards": [
            {
                "all": [
                    {
                        "kind": "feature",
                        "feature": "FEAT_SVE_B16B16",
                        "implemented": false
                    }
                ],
                "outcome": "undefined"
            }
        ],
        "operandFamilyId": "sve-fp-multiply-accumulate"
    }
];
